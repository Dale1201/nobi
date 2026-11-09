import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PageDoc, PageMetaPatch } from '@shared/types'
import { findNode } from '../lib/tree'
import { emitPageEvent, onPageEvent, saveCount } from '../lib/pageEvents'
import { registerScroller, useApp } from '../store'
import { Banner } from './Banner'
import { PageCover, PageIconAndControls } from './PageHeader'
import { EditorErrorBoundary } from './EditorErrorBoundary'
import { PageEditor, type PageEditorHandle } from './PageEditor'
import { PageTitle } from './PageTitle'
import { Backlinks } from './Backlinks'
import { FindBar } from './FindBar'
import { TopBar } from './TopBar'

const api = window.api

/** The patch that puts back what `patch` changed in `meta`. */
function undoPatch(patch: PageMetaPatch, meta: PageDoc['meta']): PageMetaPatch {
  const undo: PageMetaPatch = {}
  if (patch.icon !== undefined) undo.icon = meta.icon ?? null
  if (patch.cover !== undefined) undo.cover = meta.cover ?? null
  if (patch.coverPosition !== undefined) undo.coverPosition = meta.coverPosition ?? null
  if (patch.fullWidth !== undefined) undo.fullWidth = meta.fullWidth ?? false
  return undo
}

function applyPatch(doc: PageDoc, patch: PageMetaPatch): PageDoc {
  const meta = { ...doc.meta }
  if (patch.icon !== undefined) meta.icon = patch.icon ?? undefined
  if (patch.cover !== undefined) meta.cover = patch.cover ?? undefined
  if (patch.coverPosition !== undefined) meta.coverPosition = patch.coverPosition ?? undefined
  if (patch.fullWidth !== undefined) meta.fullWidth = patch.fullWidth
  return { ...doc, meta }
}

export function PageView({
  tabId,
  pageId,
  initialScroll,
  active,
  theme
}: {
  tabId: string
  pageId: string
  /** Where to scroll once the page shows, as when going back to it. */
  initialScroll: number
  active: boolean
  theme: 'light' | 'dark'
}): React.JSX.Element {
  const node = useApp((s) => findNode(s.tree, pageId))
  const [doc, setDoc] = useState<PageDoc | null>(null)
  // Bumped to rebuild the editor from a fresh read of the file.
  const [generation, setGeneration] = useState(0)
  const [conflict, setConflict] = useState(false)
  // The page's save count when `doc` was read: a save announced since then is not in it.
  const [readAt, setReadAt] = useState(0)
  const bodyRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<PageEditorHandle>(null)
  const getEditor = useCallback(() => editorRef.current?.editor() ?? null, [])
  const keepScroll = useRef<number | null>(initialScroll || null)
  const docRef = useRef(doc)
  useLayoutEffect(() => {
    docRef.current = doc
  })
  const onConflict = useCallback(() => setConflict(true), [])

  useEffect(() => {
    let cancelled = false
    const at = saveCount(pageId)
    void api.invoke('page:read', { id: pageId }).then((d) => {
      if (cancelled) return
      setDoc(d)
      setReadAt(at)
      setConflict(false)
    })
    return () => {
      cancelled = true
    }
  }, [pageId])

  useEffect(() => registerScroller(tabId, () => scrollRef.current?.scrollTop ?? 0), [tabId])

  // A tab being left saves at once, so a hidden tab never sits on unsaved typing.
  useEffect(() => {
    if (!active) void editorRef.current?.saveNow()
  }, [active])

  const reload = useCallback(async (): Promise<void> => {
    const id = docRef.current?.id
    if (!id) return
    let fresh: PageDoc
    let at: number
    try {
      at = saveCount(id)
      fresh = await api.invoke('page:read', { id })
    } catch (e) {
      return useApp.getState().reportError('reload', e)
    }
    if (docRef.current?.id !== id) return
    // Typing that started while the page was being read is not thrown away.
    if (editorRef.current?.hasUnsaved()) {
      editorRef.current.markConflicted()
      return setConflict(true)
    }
    keepScroll.current = scrollRef.current?.scrollTop ?? null
    setDoc(fresh)
    setReadAt(at)
    setGeneration((g) => g + 1)
    setConflict(false)
  }, [])

  const ready = doc && doc.id === pageId && node

  useLayoutEffect(() => {
    if (!ready || keepScroll.current === null || !scrollRef.current) return
    scrollRef.current.scrollTop = keepScroll.current
    keepScroll.current = null
  }, [generation, ready])

  useEffect(() => {
    const offOutside = window.api.on('page:changed', ({ id, revision }) => {
      const current = docRef.current
      if (!current || current.id !== id) return
      if (revision <= (editorRef.current?.revision() ?? current.revision)) return
      if (editorRef.current?.hasUnsaved()) setConflict(true)
      else void reload()
    })
    // Icon, cover and width changes made in another tab showing this page.
    const offTabs = onPageEvent((event) => {
      if (event.type === 'meta' && event.id === docRef.current?.id)
        setDoc((d) => (d?.id === event.id ? applyPatch(d, event.patch) : d))
    })
    return () => {
      offOutside()
      offTabs()
    }
  }, [reload])

  useEffect(() => {
    useApp.getState().setTabConflict(tabId, Boolean(ready && conflict))
  }, [tabId, ready, conflict])
  useEffect(() => () => useApp.getState().setTabConflict(tabId, false), [tabId])

  const updateMeta = (patch: PageMetaPatch): void => {
    if (!doc) return
    const id = doc.id
    const undo = undoPatch(patch, doc.meta)
    setDoc(applyPatch(doc, patch))
    // Other tabs follow only once it is saved; a failure undoes just what this patch changed.
    api.invoke('page:meta', { id, patch }).then(
      () => emitPageEvent({ type: 'meta', id, patch }),
      (e) => {
        setDoc((d) => (d?.id === id ? applyPatch(d, undo) : d))
        void useApp.getState().reportError('update', e)
      }
    )
  }

  return (
    <div className="main">
      <TopBar
        pageId={pageId}
        doc={ready ? doc : null}
        onToggleFullWidth={() => doc && updateMeta({ fullWidth: !doc.meta.fullWidth })}
      />
      {ready && conflict && (
        <Banner
          tone="warning"
          message="This page was changed outside Nobi."
          actions={[
            {
              label: 'Reload',
              onClick: () =>
                void editorRef.current?.discard().then((ok) => (ok ? reload() : undefined))
            },
            {
              label: 'Keep mine',
              onClick: () =>
                void editorRef.current?.keepMine().then((ok) => {
                  if (!ok) return
                  setConflict(false)
                  bodyRef.current?.querySelector<HTMLElement>('[contenteditable="true"]')?.focus()
                })
            }
          ]}
        />
      )}
      {ready && doc.frontmatterError && (
        <Banner
          tone="info"
          message="This page's frontmatter couldn't be read, so it's shown as text."
        />
      )}
      {ready && <FindBar active={active} getEditor={getEditor} editorKey={generation} />}
      <div className="page-scroll editable" data-testid="page-scroll" ref={scrollRef}>
        {ready && (
          <>
            <PageCover meta={doc.meta} onChange={updateMeta} />
            <div className={`page-column ${doc.meta.fullWidth ? 'full-width' : ''}`}>
              <div className={`page-header ${doc.meta.cover ? 'has-cover' : ''}`}>
                <PageIconAndControls meta={doc.meta} onChange={updateMeta} />
                <PageTitle
                  key={doc.id}
                  id={doc.id}
                  title={node.title}
                  onEnter={() =>
                    bodyRef.current?.querySelector<HTMLElement>('[contenteditable="true"]')?.focus()
                  }
                />
                <Backlinks pageId={doc.id} />
              </div>
            </div>
            <div
              className={`page-column page-body ${doc.meta.fullWidth ? 'full-width' : ''}`}
              ref={bodyRef}
            >
              <EditorErrorBoundary key={`${doc.id}:${generation}`} path={doc.path}>
                <PageEditor
                  ref={editorRef}
                  tabId={tabId}
                  readAt={readAt}
                  doc={doc}
                  theme={theme}
                  active={active}
                  onConflict={onConflict}
                />
              </EditorErrorBoundary>
            </div>
            {/* Like Notion, the space below the last block is a place to start typing. */}
            <div
              className="page-end"
              onMouseDown={(e) => {
                if (e.button !== 0 || e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return
                e.preventDefault()
                editorRef.current?.focusEnd()
              }}
            />
          </>
        )}
      </div>
    </div>
  )
}
