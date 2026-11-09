import { TextSelection } from 'prosemirror-state'
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'
import type { MenuCommand } from '@shared/ipc'
import { hasPending } from '../ai/pending'
import {
  findState,
  replaceAll,
  replaceCurrent,
  revealCurrent,
  setFindQuery,
  stepFind
} from '../editor/find/findPlugin'
import { selectionQuery } from '../editor/find/matches'
import type { AppEditor } from '../editor/schema'
import { ArrowUpIcon, ChevronDownIcon, CloseIcon } from './icons'

/** Find commands from the menu, for the active tab's page. */
export const FIND_EVENT = 'nobi:find'
export type FindCommand = Extract<MenuCommand, `find${string}`>

/** Notion's find and replace bar, at the top right of the page. */
export function FindBar({
  active,
  getEditor,
  editorKey
}: {
  active: boolean
  getEditor: () => AppEditor | null
  /** Changes when the page's editor is replaced, as a reload does. */
  editorKey: number
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [showReplace, setShowReplace] = useState(false)
  const [query, setQuery] = useState('')
  const queryRef = useRef('')
  const [replacement, setReplacement] = useState('')
  const [, refresh] = useReducer((n: number) => n + 1, 0)
  const findInput = useRef<HTMLInputElement>(null)
  // Bumped by each find command; the field is focused and selected before the next keystroke.
  const [focusRequest, requestFocus] = useReducer((n: number) => n + 1, 0)
  const editor = open ? getEditor() : null

  const search = useCallback(
    (text: string) => {
      const ed = getEditor()
      if (!ed) return
      setQuery(text)
      queryRef.current = text
      setFindQuery(ed.prosemirrorView, text)
      revealCurrent(ed.prosemirrorView)
    },
    [getEditor]
  )

  const step = useCallback(
    (by: 1 | -1) => {
      const ed = getEditor()
      if (!ed) return
      stepFind(ed.prosemirrorView, by)
      revealCurrent(ed.prosemirrorView)
      refresh()
    },
    [getEditor]
  )

  const close = useCallback(
    (selectMatch: boolean) => {
      const ed = getEditor()
      setOpen(false)
      if (!ed) return
      const view = ed.prosemirrorView
      const { matches, current } = findState(view.state)
      const match = matches[current]
      setFindQuery(view, '')
      if (selectMatch && match) {
        view.dispatch(
          view.state.tr.setSelection(TextSelection.create(view.state.doc, match.from, match.to))
        )
      }
      view.focus()
    },
    [getEditor]
  )

  useEffect(() => {
    if (!active) return
    const onCommand = (event: Event): void => {
      const cmd = (event as CustomEvent<FindCommand>).detail
      const ed = getEditor()
      if (!ed) return
      if (cmd === 'find-next' || cmd === 'find-previous') {
        if (open) step(cmd === 'find-next' ? 1 : -1)
        return
      }
      if (cmd === 'find-replace') setShowReplace(true)
      const seed = open ? '' : selectionQuery(ed.prosemirrorState)
      setOpen(true)
      if (seed || !open) search(seed || query)
      requestFocus()
    }
    window.addEventListener(FIND_EVENT, onCommand)
    return () => window.removeEventListener(FIND_EVENT, onCommand)
  }, [active, open, query, getEditor, search, step])

  useLayoutEffect(() => {
    if (focusRequest === 0) return
    findInput.current?.focus()
    findInput.current?.select()
  }, [focusRequest])

  // Matches follow edits made while the bar is open, and a reloaded page's new editor.
  useEffect(() => {
    const ed = open ? getEditor() : null
    if (!ed) return
    if (findState(ed.prosemirrorState).query !== queryRef.current)
      setFindQuery(ed.prosemirrorView, queryRef.current)
    refresh()
    return ed.onChange(refresh)
  }, [open, editorKey, getEditor])

  if (!open || !editor) return null
  const { matches, current } = findState(editor.prosemirrorState)
  const canReplace = matches.length > 0 && editor.isEditable && !hasPending(editor)
  const view = editor.prosemirrorView

  return (
    <div
      className="find-bar"
      data-testid="find-bar"
      role="search"
      // Buttons leave focus in the field, so it is never lost to a button that becomes disabled.
      onMouseDown={(e) => {
        if ((e.target as Element).closest('button')) e.preventDefault()
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.preventDefault()
        close(true)
      }}
    >
      <div className="find-row">
        <button
          className="icon-button find-toggle"
          aria-label={showReplace ? 'Hide replace' : 'Show replace'}
          aria-expanded={showReplace}
          onClick={() => setShowReplace((s) => !s)}
        >
          <ChevronDownIcon size={14} style={showReplace ? undefined : { rotate: '-90deg' }} />
        </button>
        <input
          ref={findInput}
          className="find-input"
          data-testid="find-input"
          placeholder="Find in page"
          value={query}
          onChange={(e) => search(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            e.preventDefault()
            step(e.shiftKey ? -1 : 1)
          }}
        />
        <span className="find-count" data-testid="find-count">
          {query === '' ? '' : matches.length ? `${current + 1}/${matches.length}` : 'No results'}
        </span>
        <button
          className="icon-button"
          aria-label="Previous match"
          disabled={matches.length === 0}
          onClick={() => step(-1)}
        >
          <ArrowUpIcon size={16} />
        </button>
        <button
          className="icon-button"
          aria-label="Next match"
          disabled={matches.length === 0}
          onClick={() => step(1)}
        >
          <ArrowUpIcon size={16} style={{ rotate: '180deg' }} />
        </button>
        <button className="icon-button" aria-label="Close" onClick={() => close(false)}>
          <CloseIcon size={16} />
        </button>
      </div>
      {showReplace && (
        <div className="find-row find-replace-row">
          <input
            className="find-input"
            data-testid="replace-input"
            placeholder="Replace with"
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || !canReplace) return
              e.preventDefault()
              replaceCurrent(view, replacement)
              revealCurrent(view)
            }}
          />
          <button
            className="find-action"
            disabled={!canReplace}
            onClick={() => {
              replaceCurrent(view, replacement)
              revealCurrent(view)
            }}
          >
            Replace
          </button>
          <button
            className="find-action"
            disabled={!canReplace}
            onClick={() => replaceAll(view, replacement)}
          >
            Replace all
          </button>
        </div>
      )}
    </div>
  )
}
