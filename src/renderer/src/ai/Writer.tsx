import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { TextSelection } from 'prosemirror-state'
import type { AiError, AiMode, Skill, SkillId } from '@shared/ai'
import { ArrowUpIcon, CheckIcon, SparkleIcon, StopIcon, UndoIcon } from '../components/icons'
import { selectBlocks, selectedBlockIds } from '../editor/blockSelection'
import type { AppEditor } from '../editor/schema'
import { useAppEditor } from '../editor/useAppEditor'
import { pageTitleForHref } from '../lib/tree'
import { useApp } from '../store'
import { useAi } from './aiStore'
import { nodeSelectedBlock, pageMarkdown } from './context'
import { KeyField } from './KeyField'
import { KEYS_URL, openExternal } from './links'
import {
  acceptPending,
  beginPending,
  hasPending,
  pendingOf,
  pendingRanges,
  renderPending,
  resultBlocks,
  setHighlight,
  undoPending
} from './pending'
import {
  matchingSkills,
  placementForText,
  placementOf,
  prefilledSkill,
  skillsFor
} from './writerModel'
import { registerWriter } from './writerRegistry'

const api = window.api

type Phase = 'setup' | 'prompt' | 'writing' | 'review' | 'reply'

interface Session {
  id: string
  /** Whether there is text or blocks to work on, rather than a cursor. */
  selection: boolean
  selectedBlocks: string[]
  /** The page as it was when the Writer opened, with the selection marked. */
  markdown: string
}

/** A result as it was rendered. */
interface Shown {
  text: string
  partial: boolean
}

interface Turn {
  id: string
  mode: AiMode | null
  text: string
  stopped: boolean
  /** The page could not take the result where it goes. */
  misfit: boolean
  /** The change under review when the turn began. */
  before: Shown | null
}

const MISFIT: AiError = { kind: 'request', message: 'The answer could not be placed here.' }

const WIDTH = 400

// A click just before the shortcut may not have reached the editor state yet.
function syncSelection(editor: AppEditor): void {
  const view = editor.prosemirrorView
  const dom = window.getSelection()
  if (!dom?.anchorNode || !dom.focusNode || !view.dom.contains(dom.anchorNode)) return
  try {
    const anchor = view.posAtDOM(dom.anchorNode, dom.anchorOffset)
    const head = view.posAtDOM(dom.focusNode, dom.focusOffset)
    const { selection } = view.state
    if (selection.anchor === anchor && selection.head === head) return
    editor.transact((tr) => tr.setSelection(TextSelection.create(tr.doc, anchor, head)))
  } catch {
    // The DOM selection is not in text; the editor's own selection stands.
  }
}

function newSession(editor: AppEditor): Session {
  const selectedBlocks = selectedBlockIds(editor)
  // A clicked image or other node is worked around like a cursor after its block.
  const state = editor.prosemirrorState
  const textSelected = !state.selection.empty && !nodeSelectedBlock(state)
  const mark = selectedBlocks.length
    ? { selectedBlocks }
    : textSelected
      ? { selection: true as const }
      : { cursor: true as const }
  return {
    id: crypto.randomUUID(),
    selection: selectedBlocks.length > 0 || textSelected,
    selectedBlocks,
    markdown: pageMarkdown(editor, mark, (href) => pageTitleForHref(useApp.getState().tree, href))
  }
}

/** Where the Writer sits: under the change, or under the selection or cursor. */
function anchorPos(editor: AppEditor): number {
  const state = editor.prosemirrorState
  const pending = pendingOf(state)
  if (pending?.rendered) {
    const { removed, added } = pendingRanges(pending)
    return Math.max(added.to, removed?.to ?? 0)
  }
  const ids = selectedBlockIds(editor)
  if (ids.length) {
    let end = state.selection.to
    state.doc.descendants((node, pos) => {
      if (node.type.name === 'blockContainer' && ids.includes(node.attrs.id))
        end = pos + node.nodeSize
      return true
    })
    return end
  }
  return state.selection.to
}

export function WriterHost({
  title,
  active
}: {
  title: string
  /** False while the editor's tab is hidden. */
  active: boolean
}): React.JSX.Element | null {
  const editor = useAppEditor()
  const [open, setOpen] = useState(false)
  const [phase, setPhase] = useState<Phase>('prompt')
  const [query, setQuery] = useState('')
  const [reply, setReply] = useState('')
  const [error, setError] = useState<AiError | null>(null)
  const [activeSkill, setActiveSkill] = useState(0)
  const [selection, setSelection] = useState(false)
  const [answered, setAnswered] = useState(false)
  const session = useRef<Session | null>(null)
  const request = useRef<Turn | null>(null)
  const lastShown = useRef<Shown | null>(null)
  const frame = useRef(0)
  const popup = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)

  const skills = skillsFor(selection)
  // The editor's own HTML for the reply, so it reads like the page it would be inserted into.
  const replyHtml = useMemo(
    () => (reply ? editor.blocksToHTMLLossy(resultBlocks(reply) as never) : ''),
    [editor, reply]
  )
  // Skills start a request; once Claude has answered, typing revises it.
  const shown = phase === 'prompt' && !answered ? matchingSkills(skills, query) : []

  /** Renders the turn's text; false when the page cannot take it where it goes. */
  const show = useCallback(
    (partial: boolean): boolean => {
      cancelAnimationFrame(frame.current)
      frame.current = 0
      const current = request.current
      // A turn that brought nothing leaves the result under review as it is.
      if (!current?.text || current.mode === 'reply' || !hasPending(editor)) return true
      try {
        if (renderPending(editor, current.text, partial))
          lastShown.current = { text: current.text, partial }
        return true
      } catch {
        return false
      }
    },
    [editor]
  )

  // While the answer streams, a frame the page cannot take is skipped; the last good one stays.
  const render = useCallback((): void => void show(true), [show])

  // Written to the element directly: it follows every keystroke of the stream.
  const place = useCallback((): void => {
    const dom = editor.domElement
    const container = dom?.parentElement
    const el = popup.current
    if (!dom || !container || !el) return
    const view = editor.prosemirrorView
    const pos = Math.min(anchorPos(editor), editor.prosemirrorState.doc.content.size)
    const coords = view.coordsAtPos(pos, -1)
    const box = container.getBoundingClientRect()
    // The page's own column: its first block may be a column, a toggle or a callout.
    const column = (dom.querySelector(':scope > .bn-block-group') ?? dom).getBoundingClientRect()
    const left = column.left - box.left
    el.style.top = `${coords.bottom - box.top + 6}px`
    el.style.left = `${left}px`
    el.style.width = `${Math.min(WIDTH, box.width - left)}px`
  }, [editor])

  /** `refocus` is false when the Writer goes because its tab or page did, which keep focus. */
  const close = useCallback(
    (refocus = true): void => {
      const s = session.current
      if (!s) return
      const current = request.current
      if (current && phase === 'writing') void api.invoke('ai:cancel', { requestId: current.id })
      request.current = null
      cancelAnimationFrame(frame.current)
      frame.current = 0
      if (hasPending(editor)) undoPending(editor)
      setHighlight(editor, null)
      void api.invoke('ai:end', { sessionId: s.id })
      session.current = null
      setOpen(false)
      if (refocus) editor.focus()
    },
    [editor, phase]
  )

  const accept = useCallback((): void => {
    request.current = null
    acceptPending(editor)
    close()
  }, [editor, close])

  const openWriter = useCallback((): void => {
    if (session.current || !editor.isEditable) return
    const ai = useApp.getState().settings?.ai
    if (ai && !ai.enabled) return
    if (!useAi.getState().online) return
    if (!selectedBlockIds(editor).length) syncSelection(editor)
    const s = newSession(editor)
    session.current = s
    setSelection(s.selection)
    const { selection } = editor.prosemirrorState
    if (s.selection && !s.selectedBlocks.length) {
      setHighlight(editor, { from: selection.from, to: selection.to })
      // The highlight stands in for the selection, which would keep the formatting toolbar up.
      editor.transact((tr) => tr.setSelection(TextSelection.create(tr.doc, selection.to)))
    }
    setQuery('')
    setReply('')
    setError(null)
    setAnswered(false)
    setActiveSkill(0)
    setPhase(useAi.getState().status?.hasKey ? 'prompt' : 'setup')
    setOpen(true)
  }, [editor])

  const closeRef = useRef(close)
  useLayoutEffect(() => {
    closeRef.current = close
  })
  useEffect(
    () => registerWriter(editor, { open: openWriter, close: () => closeRef.current(false) }),
    [editor, openWriter]
  )

  const run = (ask: { skill?: SkillId; instruction?: string }): void => {
    const s = session.current
    if (!s) return
    const followUp = answered
    const before = hasPending(editor) ? lastShown.current : null
    if (!hasPending(editor)) {
      const skill = ask.skill ? skills.find((k) => k.id === ask.skill) : null
      const placement = skill ? placementOf(skill.kind) : placementForText(s.selection)
      if (placement) beginPending(editor, placement, s.selectedBlocks)
    }
    if (s.selectedBlocks.length) selectBlocks(editor, s.selectedBlocks)
    const id = crypto.randomUUID()
    request.current = { id, mode: null, text: '', stopped: false, misfit: false, before }
    setError(null)
    setReply('')
    setQuery('')
    setPhase('writing')
    void api.invoke('ai:start', {
      sessionId: s.id,
      requestId: id,
      title,
      markdown: s.markdown,
      selection: s.selection,
      ...(ask.skill ? { skill: ask.skill } : {}),
      ...(ask.instruction ? { instruction: ask.instruction } : {}),
      ...(followUp ? { followUp: true } : {})
    })
  }

  // Each request reports to the Writer that started it, through its id.
  useEffect(() => {
    const finish = (error: AiError | null): void => {
      const current = request.current
      if (!current) return
      // Only the whole answer, or as far as it got, decides whether it fits.
      current.misfit = !show(current.stopped || error !== null)
      if (current.misfit) {
        if (current.before) {
          renderPending(editor, current.before.text, current.before.partial)
          lastShown.current = current.before
        } else if (hasPending(editor)) undoPending(editor)
      }
      const failed = current.misfit ? MISFIT : error
      // An edit that finished with nothing deletes the selection.
      const deleted =
        !failed &&
        !current.stopped &&
        current.mode === 'edit' &&
        !current.text &&
        hasPending(editor)
      if (deleted) {
        renderPending(editor, '')
        lastShown.current = { text: '', partial: false }
      }
      const rendered = pendingOf(editor.prosemirrorState)?.rendered ?? false
      if (rendered || (current.text && !current.misfit)) setAnswered(true)
      if (!rendered && hasPending(editor)) undoPending(editor)
      setError(failed)
      setPhase(rendered ? 'review' : current.mode === 'reply' && current.text ? 'reply' : 'prompt')
    }
    const offs = [
      api.on('ai:delta', (delta) => {
        const current = request.current
        if (!current || delta.requestId !== current.id) return
        current.mode = delta.mode
        current.text = delta.text
        if (delta.mode === 'reply') {
          setReply(delta.text)
          return
        }
        // Text before a tool call arrives as a reply; an edit or insert replaces it.
        setReply('')
        if (!frame.current) frame.current = requestAnimationFrame(render)
      }),
      api.on('ai:done', (done) => {
        if (done.requestId === request.current?.id) finish(null)
      }),
      api.on('ai:error', (failed) => {
        if (failed.requestId === request.current?.id) finish(failed)
      })
    ]
    return () => offs.forEach((off) => off())
  }, [editor, render, show])

  // A hidden tab or a closed page takes its Writer with it.
  useEffect(() => {
    if (!active) closeRef.current(false)
  }, [active])
  useEffect(() => () => closeRef.current(false), [])

  useLayoutEffect(() => {
    if (!open) return
    place()
    const off = editor.onChange(place)
    window.addEventListener('resize', place)
    return () => {
      off?.()
      window.removeEventListener('resize', place)
    }
  }, [open, phase, reply, editor, place])

  useEffect(() => {
    if (open) popup.current?.scrollIntoView({ block: 'nearest' })
  }, [open, phase])

  useEffect(() => {
    if (open && phase !== 'writing' && phase !== 'setup') input.current?.focus()
  }, [open, phase])

  // Clicking away keeps a finished change, and leaves a running one alone, as in Notion.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (popup.current?.contains(e.target as Node)) return
      if (phase === 'writing') {
        // The page does not take clicks while Claude writes.
        if (editor.domElement?.contains(e.target as Node)) {
          e.preventDefault()
          e.stopPropagation()
        }
        return
      }
      if (phase === 'review') accept()
      else close()
    }
    document.addEventListener('mousedown', onDown, true)
    return () => document.removeEventListener('mousedown', onDown, true)
  }, [open, phase, editor, accept, close])

  if (!open || !editor.domElement?.parentElement) return null

  const send = (): void => {
    const text = query.trim()
    const s = session.current
    if (!s) return
    if (phase === 'prompt' && shown.length && query === query.trimStart()) {
      const skill = shown[Math.min(activeSkill, shown.length - 1)]
      if (skill && (!text || matchingSkills([skill], query).length)) return choose(skill)
    }
    if (!text) {
      if (phase === 'review') accept()
      return
    }
    const prefilled = prefilledSkill(skills, query)
    run(prefilled && !answered ? { skill: prefilled.id, instruction: text } : { instruction: text })
  }

  const choose = (skill: Skill): void => {
    if (skill.prefill) {
      setQuery(skill.prefill)
      input.current?.focus()
      return
    }
    run({ skill: skill.id })
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send()
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && shown.length) {
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      setActiveSkill((i) => (i + step + shown.length) % shown.length)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      if (phase === 'prompt' || phase === 'reply') close()
    } else if (e.key === 'Backspace' && !query && phase === 'prompt') {
      e.preventDefault()
      close()
    } else if (e.key === 'z' && e.metaKey && !e.shiftKey && !query && phase === 'review') {
      e.preventDefault()
      close()
    }
  }

  const insertReply = (): void => {
    const s = session.current
    if (!s) return
    if (s.selection) beginPending(editor, 'insertBelow', s.selectedBlocks)
    else beginPending(editor, 'insertAtCursor')
    try {
      renderPending(editor, reply)
    } catch {
      undoPending(editor)
      setError(MISFIT)
      input.current?.focus()
      return
    }
    acceptPending(editor)
    close()
  }

  const placeholder = phase === 'writing' ? 'Writing…' : 'Edit with AI'

  return createPortal(
    <div
      ref={popup}
      className="nb-writer"
      role="dialog"
      aria-label="AI"
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (phase === 'setup' && e.key === 'Escape') {
          e.preventDefault()
          close()
        }
      }}
    >
      {phase === 'setup' ? (
        <div className="nb-writer-setup">
          <div className="nb-writer-setup-title">Set up AI</div>
          <p>
            Nobsidian uses Claude, with your own Anthropic API key. AI features send the text of the
            page you&apos;re on to Anthropic. Images, files, drawings and other pages are never
            sent.{' '}
            <button
              type="button"
              className="nb-writer-link"
              onClick={() => {
                close()
                useApp.getState().setOverlay({ kind: 'settings', section: 'ai' })
              }}
            >
              Learn more
            </button>
          </p>
          <KeyField autoFocus onSaved={() => setPhase('prompt')} />
          <button type="button" className="nb-writer-link" onClick={() => openExternal(KEYS_URL)}>
            Get a key from Anthropic
          </button>
        </div>
      ) : (
        <>
          {(phase === 'reply' || phase === 'review') && reply && (
            <div
              className="nb-writer-reply"
              onClick={(e) => {
                const link = (e.target as HTMLElement).closest('a')
                if (!link) return
                e.preventDefault()
                openExternal(link.href)
              }}
              dangerouslySetInnerHTML={{ __html: replyHtml }}
            />
          )}
          <div className="nb-writer-input-row">
            <SparkleIcon size={18} className="nb-writer-icon" />
            <input
              ref={input}
              className="nb-writer-input"
              aria-label="Ask AI"
              placeholder={placeholder}
              value={query}
              readOnly={phase === 'writing'}
              onChange={(e) => {
                setQuery(e.target.value)
                setActiveSkill(0)
              }}
              onKeyDown={onKeyDown}
            />
            {phase === 'writing' ? (
              <button
                type="button"
                className="nb-writer-stop"
                aria-label="Stop"
                title="Stop"
                onClick={() => {
                  const current = request.current
                  if (!current) return
                  current.stopped = true
                  void api.invoke('ai:cancel', { requestId: current.id })
                }}
              >
                <StopIcon size={16} />
              </button>
            ) : phase === 'review' && !query ? (
              <div className="nb-writer-actions">
                <button
                  type="button"
                  className="nb-writer-undo"
                  title="Undo ⌘Z"
                  onClick={() => close()}
                >
                  <UndoIcon size={16} />
                  Undo
                </button>
                <button
                  type="button"
                  className="nb-writer-accept"
                  title="Accept ↵"
                  onClick={accept}
                >
                  <CheckIcon size={16} />
                  Accept
                </button>
              </div>
            ) : phase === 'reply' && !query ? (
              <button type="button" className="nb-writer-insert" onClick={insertReply}>
                Insert below
              </button>
            ) : (
              <button
                type="button"
                className="nb-writer-send"
                aria-label="Submit"
                disabled={!query.trim()}
                onClick={send}
              >
                <ArrowUpIcon size={14} />
              </button>
            )}
          </div>
          {error && (
            <div className="nb-writer-error" role="alert">
              {error.message}
              {error.kind === 'auth' && (
                <button
                  type="button"
                  className="nb-writer-link"
                  onClick={() => {
                    close()
                    useApp.getState().setOverlay({ kind: 'settings', section: 'ai' })
                  }}
                >
                  Open Settings
                </button>
              )}
            </div>
          )}
          {shown.length > 0 && (
            <div className="nb-writer-skills" role="listbox" aria-label="Skills">
              <div className="nb-writer-skills-title">Skills</div>
              {shown.map((skill, i) => (
                <button
                  key={skill.id}
                  type="button"
                  role="option"
                  aria-selected={i === activeSkill}
                  className={`nb-writer-skill ${i === activeSkill ? 'active' : ''}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActiveSkill(i)}
                  onClick={() => choose(skill)}
                >
                  {skill.label}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>,
    editor.domElement.parentElement
  )
}
