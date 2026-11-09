import { useEffect, useRef, useState } from 'react'
import type { PageNode } from '@shared/types'
import { activeTab, currentEntry, nearest, type Tab } from '../lib/tabs'
import { findNode } from '../lib/tree'
import { useApp } from '../store'
import { ChevronLeftIcon, ChevronRightIcon, CloseIcon, PlusIcon, SidebarIcon } from './icons'
import { Menu } from './menu/Menu'
import { PageIconView } from './PageIconView'

const api = window.api
// The pointer moves this far before a press on a tab becomes a drag.
const DRAG_THRESHOLD = 4

function tabLabel(tab: Tab, tree: PageNode[]): { title: string; icon?: string } {
  const entry = currentEntry(tab)
  if (entry.kind === 'trash') return { title: entry.title || 'Untitled', icon: entry.icon }
  const node = findNode(tree, entry.pageId)
  return { title: node?.title || 'Untitled', icon: node?.icon }
}

function useFullscreen(): boolean {
  const [fullscreen, setFullscreen] = useState(false)
  useEffect(() => api.on('window:fullscreen', setFullscreen), [])
  return fullscreen
}

/** The window's top row: traffic lights, sidebar toggle, back and forward, tabs and the new tab button. */
export function TabBar(): React.JSX.Element {
  const state = useApp((s) => s.tabs)
  const tree = useApp((s) => s.tree)
  const collapsed = useApp((s) => s.settings?.sidebarCollapsed ?? false)
  const width = useApp((s) => s.sidebarDrag ?? s.settings?.sidebarWidth ?? 240)
  const conflicts = useApp((s) => s.conflictTabs)
  const fullscreen = useFullscreen()
  const app = useApp.getState
  const listRef = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState<{ tabId: string; anchor: DOMRect } | null>(null)
  const [drag, setDrag] = useState<{ tabId: string; boundary: number; x: number } | null>(null)

  const usable = (e: Tab['entries'][number]): boolean =>
    e.kind === 'trash' || findNode(tree, e.pageId) !== null
  const tab = state ? activeTab(state) : null
  const canBack = tab !== null && nearest(tab, -1, usable) !== null
  const canForward = tab !== null && nearest(tab, 1, usable) !== null

  useEffect(() => {
    listRef.current
      ?.querySelector('.tab.active')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [state?.activeId, state?.tabs.length])

  /** Index of the gap between tabs nearest to x: 0 is before the first tab. */
  const boundaryAt = (x: number): { boundary: number; x: number } => {
    const tabs = [...(listRef.current?.querySelectorAll<HTMLElement>('.tab') ?? [])]
    const list = listRef.current!.getBoundingClientRect()
    let boundary = tabs.length
    for (let i = 0; i < tabs.length; i++) {
      const r = tabs[i].getBoundingClientRect()
      if (x < r.left + r.width / 2) {
        boundary = i
        break
      }
    }
    const edge =
      boundary < tabs.length
        ? tabs[boundary].getBoundingClientRect().left
        : tabs[tabs.length - 1].getBoundingClientRect().right
    return { boundary, x: edge - list.left + listRef.current!.scrollLeft }
  }

  const onTabPointerDown = (e: React.PointerEvent<HTMLDivElement>, id: string): void => {
    if (e.button !== 0 || (e.target as Element).closest('.tab-close')) return
    app().activateTab(id)
    const startX = e.clientX
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    let dragging = false
    const move = (ev: PointerEvent): void => {
      if (!dragging && Math.abs(ev.clientX - startX) < DRAG_THRESHOLD) return
      dragging = true
      setDrag({ tabId: id, ...boundaryAt(ev.clientX) })
    }
    const up = (ev: PointerEvent): void => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      setDrag(null)
      if (!dragging || ev.type === 'pointercancel') return
      const from = app().tabs!.tabs.findIndex((t) => t.id === id)
      const { boundary } = boundaryAt(ev.clientX)
      app().moveTab(id, boundary > from ? boundary - 1 : boundary)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  const tabs = state?.tabs ?? []
  const menuIndex = menu ? tabs.findIndex((t) => t.id === menu.tabId) : -1

  return (
    <header
      className={[
        'tab-bar drag-region',
        collapsed ? 'sidebar-collapsed' : '',
        fullscreen ? 'fullscreen' : ''
      ].join(' ')}
    >
      <div
        className="tab-bar-lead"
        style={{
          width: collapsed ? undefined : width,
          paddingLeft: fullscreen ? 12 : api.windowControls.inset
        }}
      >
        <button
          className="tab-bar-button no-drag"
          aria-label={collapsed ? 'Show sidebar' : 'Hide sidebar'}
          title={collapsed ? 'Show sidebar' : 'Hide sidebar'}
          onClick={() => void app().updateSettings({ sidebarCollapsed: !collapsed })}
        >
          <SidebarIcon size={20} />
        </button>
      </div>
      <div className="tab-bar-nav">
        <button
          className="tab-bar-button no-drag"
          aria-label="Back"
          title="Back"
          disabled={!canBack}
          onClick={() => app().back()}
        >
          <ChevronLeftIcon size={20} />
        </button>
        <button
          className="tab-bar-button no-drag"
          aria-label="Forward"
          title="Forward"
          disabled={!canForward}
          onClick={() => app().forward()}
        >
          <ChevronRightIcon size={20} />
        </button>
      </div>
      <div
        className="tab-list"
        ref={listRef}
        role="tablist"
        onWheel={(e) => {
          if (e.deltaX === 0) e.currentTarget.scrollLeft += e.deltaY
        }}
      >
        <div className="tab-strip" style={{ maxWidth: tabs.length * 200 + 40 }}>
          {tabs.map((t, i) => {
            const { title, icon } = tabLabel(t, tree)
            const active = t.id === state?.activeId
            const conflict = !active && conflicts.includes(t.id)
            return (
              <div
                key={t.id}
                role="tab"
                aria-selected={active}
                aria-label={title}
                title={title}
                data-testid={`tab-${title}`}
                className={[
                  'tab no-drag',
                  active ? 'active' : '',
                  i === tabs.length - 1 ? 'last' : '',
                  menu?.tabId === t.id ? 'menu-open' : '',
                  conflict ? 'conflict' : ''
                ].join(' ')}
                onPointerDown={(e) => onTabPointerDown(e, t.id)}
                onMouseDown={(e) => {
                  if (e.button === 1) e.preventDefault()
                }}
                onAuxClick={(e) => {
                  if (e.button === 1) app().closeTab(t.id)
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setMenu({ tabId: t.id, anchor: new DOMRect(e.clientX, e.clientY, 0, 0) })
                }}
              >
                <span className="tab-inner">
                  <span className="tab-icon">
                    <PageIconView icon={icon} size={14} />
                  </span>
                  <span className="tab-title">{title}</span>
                </span>
                {conflict && <span className="tab-conflict" aria-label="Changed outside Nobi" />}
                <span className="tab-close">
                  <button
                    aria-label={`Close ${title}`}
                    tabIndex={-1}
                    onClick={(e) => {
                      e.stopPropagation()
                      app().closeTab(t.id)
                    }}
                  >
                    <CloseIcon size={16} />
                  </button>
                </span>
              </div>
            )
          })}
          <div className="tab-bar-new">
            <button
              className="tab-bar-button no-drag"
              aria-label="New tab"
              title="New tab"
              onClick={() => app().newTab()}
            >
              <PlusIcon size={20} />
            </button>
          </div>
          {drag && <div className="tab-drop-line" style={{ left: drag.x - 1 }} />}
        </div>
      </div>
      {menu && menuIndex !== -1 && (
        <Menu
          anchor={menu.anchor}
          onClose={() => setMenu(null)}
          entries={[
            {
              kind: 'item',
              id: 'duplicate',
              label: 'Duplicate Tab',
              onSelect: () => app().duplicateTab(menu.tabId)
            },
            {
              kind: 'item',
              id: 'reopen',
              label: 'Reopen Closed Tab',
              hint: '⌘⇧T',
              disabled: !state?.closed.length,
              onSelect: () => app().reopenClosedTab()
            },
            { kind: 'separator' },
            {
              kind: 'item',
              id: 'close',
              label: 'Close Tab',
              hint: '⌘W',
              onSelect: () => app().closeTab(menu.tabId)
            },
            {
              kind: 'item',
              id: 'close-others',
              label: 'Close Other Tabs',
              disabled: tabs.length === 1,
              onSelect: () => app().closeTabs(menu.tabId, 'others')
            },
            {
              kind: 'item',
              id: 'close-left',
              label: 'Close Tabs to the Left',
              disabled: menuIndex === 0,
              onSelect: () => app().closeTabs(menu.tabId, 'left')
            },
            {
              kind: 'item',
              id: 'close-right',
              label: 'Close Tabs to the Right',
              disabled: menuIndex === tabs.length - 1,
              onSelect: () => app().closeTabs(menu.tabId, 'right')
            }
          ]}
        />
      )}
    </header>
  )
}
