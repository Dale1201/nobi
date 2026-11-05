import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref
} from 'react'
import type { Block } from '@shared/core/blocks'
import { pageLinkHref } from '@shared/core/links'
import { openHref } from '../lib/navigation'
import { SAVE_DELAY_MS } from '@shared/editor'
import type { PageDoc } from '@shared/types'
import { codeBlockOptions } from '@blocknote/code-block'
import { Editor, type EditorContent } from '../editor/Editor'
import { createLanguageResolver, withEditorLanguages } from '../editor/codeLanguages'
import type { AppBlock, AppEditor, AppPartialBlock } from '../editor/schema'
import { resolveAssetUrl } from '../lib/assets'
import { usePageLink } from '../lib/pageLink'
import { prepareNotionPaste } from '../editor/notionPaste'
import { emitPageEvent, onPageEvent, saveCount } from '../lib/pageEvents'
import { registerFlusher, useApp } from '../store'

const editorLanguage = createLanguageResolver(codeBlockOptions.supportedLanguages)
const api = window.api

/** `auto`: the typing debounce. `leave`: the page is closing. `force`: the user chose Keep mine. */
type SaveMode = 'auto' | 'leave' | 'force'

export interface PageEditorHandle {
  /** Edits not yet on disk: typed, being saved, or held back by a conflict. */
  hasUnsaved(): boolean
  /** The file revision this editor's content is based on. */
  revision(): number
  /** Saves what is on screen over the version changed outside the app; false if the save failed. */
  keepMine(): Promise<boolean>
  /** Moves unsaved edits into the page's history before a reload; false if that failed. */
  discard(): Promise<boolean>
  /** Saves pending edits now instead of after the typing pause. */
  saveNow(): Promise<void>
  /** Holds back saves until the user picks a version, as after a conflicting outside edit. */
  markConflicted(): void
  /** Puts the caret on an empty line at the end of the page. */
  focusEnd(): void
  /** The page's editor, once it is ready. */
  editor(): AppEditor | null
}

export function PageEditor({
  tabId,
  readAt,
  doc,
  theme,
  active,
  onConflict,
  ref
}: {
  tabId: string
  /** The page's save count when `doc` was read. */
  readAt: number
  doc: PageDoc
  theme: 'light' | 'dark'
  /** False while the editor's tab is hidden. */
  active: boolean
  onConflict: () => void
  ref?: Ref<PageEditorHandle>
}): React.JSX.Element {
  // Edits this page's previous editor could not save; this editor carries on with them.
  const [rescued] = useState(() => useApp.getState().rescued[doc.id])
  const pending = useRef<Block[] | null>(rescued?.blocks ?? null)
  const latest = useRef<Block[] | null>(rescued?.blocks ?? null)
  const revision = useRef(rescued?.revision ?? doc.revision)
  const conflicted = useRef(rescued?.conflicted ?? false)
  const failed = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inFlight = useRef<Promise<void> | null>(null)
  const mounted = useRef(false)
  const lastColor = useApp((s) => s.settings?.lastColor)
  const pageLink = usePageLink()
  const [source] = useState(() => ({}))
  const content = useRef<EditorContent>(null)

  const keepDraft = useCallback(
    (blocks: Block[]) => api.invoke('history:draft', { id: doc.id, blocks }),
    [doc.id]
  )

  const save = useCallback(
    async (mode: SaveMode): Promise<void> => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
      // One save at a time, so each is based on the revision the previous one returned.
      while (inFlight.current) await inFlight.current.catch(() => {})
      const blocks = pending.current
      if (!blocks || (conflicted.current && mode === 'auto')) return
      pending.current = null
      const write = async (): Promise<void> => {
        failed.current = false
        try {
          // A page left during a conflict keeps the other version; these edits go to history.
          if (conflicted.current && mode === 'leave') return await keepDraft(blocks)
          const result = await api.invoke('page:write', {
            id: doc.id,
            blocks,
            revision: revision.current,
            force: mode === 'force'
          })
          if (result.ok) {
            revision.current = result.revision
            conflicted.current = false
            emitPageEvent({ type: 'saved', id: doc.id, source })
          } else if (result.reason === 'conflict') {
            conflicted.current = true
            if (mode === 'leave') return await keepDraft(blocks)
            pending.current ??= blocks
            onConflict()
          }
        } catch (err) {
          failed.current = true
          pending.current ??= blocks
          void useApp.getState().reportError('save', err)
        }
      }
      inFlight.current = write().finally(() => {
        inFlight.current = null
      })
      await inFlight.current
    },
    [doc.id, onConflict, keepDraft, source]
  )

  useImperativeHandle(
    ref,
    () => ({
      hasUnsaved: () => pending.current !== null || inFlight.current !== null || conflicted.current,
      revision: () => revision.current,
      saveNow: () => save('auto'),
      markConflicted: () => {
        conflicted.current = true
      },
      focusEnd: () => content.current?.focusEnd(),
      editor: () => content.current?.editor ?? null,
      keepMine: async () => {
        pending.current = latest.current ?? pending.current
        await save('force')
        return !conflicted.current && !failed.current
      },
      discard: async () => {
        if (timer.current) clearTimeout(timer.current)
        while (inFlight.current) await inFlight.current.catch(() => {})
        const blocks = pending.current
        pending.current = null
        if (blocks) {
          try {
            await keepDraft(blocks)
          } catch (err) {
            pending.current ??= blocks
            conflicted.current = true
            void useApp.getState().reportError('save', err)
            return false
          }
        }
        conflicted.current = false
        return true
      }
    }),
    [save, keepDraft]
  )

  const unsaved = useCallback(
    () => pending.current !== null || inFlight.current !== null || conflicted.current,
    []
  )

  /** Another tab saved this page: show its text here, unless edits here would be lost. */
  const showSaved = useCallback(async (): Promise<void> => {
    if (unsaved()) {
      conflicted.current = true
      return onConflict()
    }
    const fresh = await api.invoke('page:read', { id: doc.id }).catch(() => null)
    if (!fresh || !mounted.current) return
    if (unsaved()) {
      conflicted.current = true
      return onConflict()
    }
    revision.current = fresh.revision
    latest.current = null
    content.current?.replace(
      withEditorLanguages(fresh.blocks, editorLanguage) as unknown as AppPartialBlock[]
    )
  }, [doc.id, onConflict, unsaved])

  // A save another tab announced while this page was read is caught up on here.
  const [readAtMount] = useState(readAt)
  useEffect(() => {
    const off = onPageEvent((event) => {
      if (event.type !== 'saved' || event.id !== doc.id || event.source === source) return
      void showSaved()
    })
    if (saveCount(doc.id) !== readAtMount) void showSaved()
    return off
  }, [doc.id, source, showSaved, readAtMount])

  useEffect(() => {
    if (!rescued) return
    useApp.getState().takeRescued(doc.id)
    if (rescued.conflicted) onConflict()
    else void save('auto')
  }, [rescued, doc.id, onConflict, save])

  useEffect(() => {
    mounted.current = true
    const flush = async (): Promise<boolean> => {
      await save('leave')
      return pending.current === null
    }
    const unregister = registerFlusher(flush)
    return () => {
      mounted.current = false
      unregister()
      void flush().then((saved) => {
        // Checked after the flush: StrictMode remounts this same editor, which still has the edits.
        if (!saved && !mounted.current) {
          void useApp.getState().rescue(doc.id, {
            blocks: pending.current!,
            revision: revision.current,
            conflicted: conflicted.current
          })
        }
        return api.invoke('history:checkpoint', { id: doc.id })
      })
    }
  }, [save, doc.id])

  const onChange = useCallback(
    (blocks: AppBlock[]) => {
      latest.current = blocks as unknown as Block[]
      pending.current = latest.current
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => void save('auto'), SAVE_DELAY_MS)
    },
    [save]
  )

  const initialBlocks = useMemo(
    () =>
      withEditorLanguages(
        rescued?.blocks ?? doc.blocks,
        editorLanguage
      ) as unknown as AppPartialBlock[],
    [rescued, doc.blocks]
  )

  return (
    <Editor
      initialBlocks={initialBlocks}
      contentRef={content}
      title={doc.title}
      pageId={doc.id}
      drawingSlot={{ tabId, pageId: doc.id }}
      theme={theme}
      acceptsFiles={active}
      active={active}
      onChange={onChange}
      uploadFile={async (file) =>
        api.invoke('attachment:save', {
          name: file.name,
          data: new Uint8Array(await file.arrayBuffer())
        })
      }
      resolveFileUrl={async (url) => resolveAssetUrl(url)}
      createSubPage={async () => {
        await save('auto')
        const node = await api.invoke('page:create', { parentId: doc.id })
        void useApp.getState().setExpanded(doc.id, true)
        return pageLinkHref(node.id)
      }}
      createLinkedPage={async (title) => {
        await save('auto')
        const node = await api.invoke('page:create', { parentId: doc.id, title })
        void useApp.getState().setExpanded(doc.id, true)
        return pageLinkHref(node.id)
      }}
      openLink={openHref}
      pageLink={pageLink}
      lastColor={lastColor}
      onPickColor={(picked) => void useApp.getState().updateSettings({ lastColor: picked })}
      pasteNotion={async (clipboard) => {
        const { blocks, images, uploads } = await prepareNotionPaste(clipboard)
        if (uploads > 0) {
          useApp
            .getState()
            .showMessage(
              "Images and files uploaded to Notion can't be pasted. Import the page to bring them over."
            )
        }
        return { blocks: withEditorLanguages(blocks, editorLanguage), images }
      }}
    />
  )
}
