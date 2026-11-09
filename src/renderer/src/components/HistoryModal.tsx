import { useEffect, useRef, useState } from 'react'
import type { HistoryVersion, PageDoc } from '@shared/types'
import { versionLabels } from '../lib/time'
import { flushAll, useApp } from '../store'
import { CloseIcon } from './icons'
import { ConfirmDialog, Modal } from './Modal'
import { ReadOnlyPage } from './ReadOnlyPage'

const api = window.api

/** Notion's version history: a read-only preview, the list of versions, and Restore. */
export function HistoryModal({
  pageId,
  theme
}: {
  pageId: string
  theme: 'light' | 'dark'
}): React.JSX.Element {
  const [versions, setVersions] = useState<HistoryVersion[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ version: string; doc: PageDoc } | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [failed, setFailed] = useState(false)
  const seq = useRef(0)
  const listRef = useRef<HTMLDivElement>(null)
  const labels = versionLabels(versions?.map((v) => v.at) ?? [])
  const close = (): void => {
    useApp.getState().setOverlay(null)
    queueMicrotask(() =>
      document
        .querySelector<HTMLElement>('.tab-pane.active .page-body [contenteditable="true"]')
        ?.focus()
    )
  }

  useEffect(() => {
    let cancelled = false
    // Saved first, so what is on screen is the newest version and restoring never loses it.
    void flushAll()
      .then(() => api.invoke('history:list', { id: pageId }))
      .then((list) => {
        if (cancelled) return
        setVersions(list)
        setSelected(list[0]?.id ?? null)
      })
      .catch((e) => {
        if (cancelled) return
        setFailed(true)
        void useApp.getState().reportError('load the history of', e)
      })
    return () => {
      cancelled = true
    }
  }, [pageId])

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('.history-item.selected')?.focus()
  }, [versions])

  useEffect(() => {
    if (!selected) return
    const mine = ++seq.current
    void api
      .invoke('history:read', { id: pageId, version: selected })
      .then((doc) => {
        if (mine === seq.current) setPreview({ version: selected, doc })
      })
      .catch((e) => {
        if (mine === seq.current) void useApp.getState().reportError('load the history of', e)
      })
  }, [pageId, selected])

  const restore = async (): Promise<void> => {
    if (!selected) return
    close()
    await api
      .invoke('history:restore', { id: pageId, version: selected })
      .catch((e) => useApp.getState().reportError('restore', e))
  }

  return (
    <Modal onClose={close} className="history" label="Page history">
      <div className="history-preview">
        {/* Keyed by the loaded version: the editor reads its content only when created. */}
        {preview && <ReadOnlyPage key={preview.version} doc={preview.doc} theme={theme} />}
        {failed && <div className="history-empty">{"Couldn't load this page's history."}</div>}
        {versions?.length === 0 && (
          <div className="history-empty">
            No versions yet. Nobi keeps a version every 10 minutes while you edit, and when you
            leave a page.
          </div>
        )}
      </div>
      <div className="history-side">
        <div className="history-header">
          <span>Page history</span>
          <button className="icon-button" aria-label="Close" onClick={close}>
            <CloseIcon size={16} />
          </button>
        </div>
        <div className="history-list" ref={listRef}>
          {versions?.map((v, i) => (
            <button
              key={v.id}
              className={`history-item ${v.id === selected ? 'selected' : ''}`}
              onClick={() => setSelected(v.id)}
            >
              {labels[i]}
              {i === 0 && <span className="history-current">Current</span>}
            </button>
          ))}
        </div>
        <div className="history-footer">
          <button
            className="button-primary"
            disabled={!selected || selected === versions?.[0]?.id}
            onClick={() => setConfirming(true)}
          >
            Restore version
          </button>
        </div>
      </div>
      {confirming && selected && versions && (
        <ConfirmDialog
          title={`Restore the version from ${labels[versions.findIndex((v) => v.id === selected)]}?`}
          message="The page's current content stays in its history."
          confirmLabel="Restore"
          onConfirm={() => void restore()}
          onClose={() => setConfirming(false)}
        />
      )}
    </Modal>
  )
}
