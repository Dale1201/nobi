import { useEffect, useRef, useState, type DragEvent } from 'react'
import type { PageNode } from '@shared/types'
import { tabTarget } from '../lib/navigation'
import { dropTarget, type DropPosition } from '../lib/tree'
import { useApp } from '../store'
import { ChevronRightIcon, DotsIcon, PlusIcon } from './icons'
import { Menu } from './menu/Menu'
import {
  copyPathEntry,
  duplicatePageEntry,
  favoriteEntry,
  moveToEntry,
  openInTabEntry,
  renameEntry,
  revealEntry,
  trashEntry
} from './pageActions'
import { PageIconView } from './PageIconView'

const DRAG_TYPE = 'application/x-nobi-page'
// Selectors must return stable references, or zustand re-renders forever.
const NONE: string[] = []

export function SidebarRow({
  node,
  depth,
  draggable = true,
  expandable = true,
  scope = 'pages'
}: {
  node: PageNode
  depth: number
  draggable?: boolean
  expandable?: boolean
  /** Favorites keep their own expansion, apart from the page tree. */
  scope?: 'pages' | 'favorites'
}): React.JSX.Element {
  const currentId = useApp((s) => s.currentId)
  const expandedIds = useApp((s) => (s.workspace && s.settings?.expanded[s.workspace.root]) || NONE)
  const favorites = useApp((s) => s.favorites)
  const renamingId = useApp((s) => s.renamingId)
  const app = useApp.getState
  const [menu, setMenu] = useState<DOMRect | null>(null)
  const [drop, setDrop] = useState<DropPosition | null>(null)

  const rowRef = useRef<HTMLDivElement>(null)
  const isCurrent = currentId === node.id
  // Only the page tree answers a reveal, once, so favorites and remounts never move the list.
  const revealRequest = useApp((s) => s.revealRequest)
  useEffect(() => {
    if (scope !== 'pages' || revealRequest !== node.id) return
    rowRef.current?.scrollIntoView({ block: 'nearest' })
    useApp.getState().takeReveal(node.id)
  }, [revealRequest, node.id, scope])

  const expandKey = scope === 'favorites' ? `fav:${node.id}` : node.id
  const expanded = expandable && expandedIds.includes(expandKey)

  const expandTimer = useRef<number | null>(null)
  const stopExpandTimer = (): void => {
    if (expandTimer.current !== null) window.clearTimeout(expandTimer.current)
    expandTimer.current = null
  }
  useEffect(() => stopExpandTimer, [])
  const isFavorite = favorites.includes(node.id)
  const indent = 6 + depth * 14

  const positionFor = (e: DragEvent<HTMLDivElement>): DropPosition => {
    const rect = e.currentTarget.getBoundingClientRect()
    const y = e.clientY - rect.top
    if (y < rect.height * 0.25) return 'before'
    if (y > rect.height * 0.75) return 'after'
    return 'inside'
  }

  return (
    <>
      <div
        ref={rowRef}
        className={[
          'sidebar-row',
          isCurrent ? 'active' : '',
          menu ? 'menu-open' : '',
          drop ? `drop-${drop}` : ''
        ].join(' ')}
        style={{ paddingLeft: indent }}
        data-testid={`sidebar-row-${node.title || 'Untitled'}`}
        draggable={draggable && renamingId !== node.id}
        onClick={(e) => app().openPage(node.id, { scroll: false, tab: tabTarget(e) })}
        onMouseDown={(e) => {
          if (e.button === 1) e.preventDefault()
        }}
        onAuxClick={(e) => {
          if (e.button === 1) app().openPage(node.id, { tab: tabTarget(e) })
        }}
        onDragStart={(e) => {
          e.dataTransfer.setData(DRAG_TYPE, node.id)
          e.dataTransfer.effectAllowed = 'move'
        }}
        onDragOver={(e) => {
          if (!draggable || !e.dataTransfer.types.includes(DRAG_TYPE)) return
          e.preventDefault()
          const position = positionFor(e)
          setDrop(position)
          if (position === 'inside' && expandable && !expanded && node.children.length) {
            expandTimer.current ??= window.setTimeout(() => {
              expandTimer.current = null
              void app().setExpanded(expandKey, true)
            }, 500)
          } else {
            stopExpandTimer()
          }
        }}
        onDragLeave={() => {
          setDrop(null)
          stopExpandTimer()
        }}
        onDrop={(e) => {
          e.preventDefault()
          stopExpandTimer()
          setDrop(null)
          const dragged = e.dataTransfer.getData(DRAG_TYPE)
          const target = dragged && dropTarget(app().tree, dragged, node.id, positionFor(e))
          if (target) void app().movePage(dragged, target.parentId, target.index)
        }}
      >
        {/* Like Notion, the page icon turns into the expand arrow on hover. */}
        <span className={`sidebar-row-lead ${expandable ? 'expandable' : ''}`}>
          <span className="page-icon">
            <PageIconView icon={node.icon} />
          </span>
          {expandable && (
            <button
              className="icon-button sidebar-row-toggle"
              aria-label={expanded ? 'Collapse' : 'Expand'}
              onClick={(e) => {
                e.stopPropagation()
                void app().setExpanded(expandKey, !expanded)
              }}
            >
              <ChevronRightIcon size={12} className={`toggle-arrow ${expanded ? 'open' : ''}`} />
            </button>
          )}
        </span>
        {renamingId === node.id ? (
          <RenameInput node={node} />
        ) : (
          <span className="sidebar-row-title">{node.title || 'Untitled'}</span>
        )}
        <span className="sidebar-row-actions">
          <button
            className="icon-button"
            aria-label="Page actions"
            onClick={(e) => {
              e.stopPropagation()
              setMenu(e.currentTarget.getBoundingClientRect())
            }}
          >
            <DotsIcon size={14} />
          </button>
          <button
            className="icon-button"
            aria-label="Add a page inside"
            onClick={(e) => {
              e.stopPropagation()
              void app().createPage(node.id, undefined, {
                expandKey,
                scroll: scope === 'pages'
              })
            }}
          >
            <PlusIcon size={14} />
          </button>
        </span>
      </div>
      {menu && (
        <Menu
          anchor={menu}
          onClose={() => setMenu(null)}
          header="Page"
          entries={[
            favoriteEntry(node.id, isFavorite),
            { kind: 'separator' },
            duplicatePageEntry(node.id),
            renameEntry(() => app().setRenaming(node.id)),
            moveToEntry(node.id),
            trashEntry(node.id),
            { kind: 'separator' },
            openInTabEntry(node.id),
            revealEntry(node.id),
            copyPathEntry(node.id)
          ]}
        />
      )}
      {expanded &&
        (node.children.length ? (
          node.children.map((child) => (
            <SidebarRow
              key={child.id}
              node={child}
              depth={depth + 1}
              scope={scope}
              draggable={draggable}
            />
          ))
        ) : (
          <div className="sidebar-empty" style={{ paddingLeft: indent + 14 + 28 }}>
            No pages inside
          </div>
        ))}
    </>
  )
}

function RenameInput({ node }: { node: PageNode }): React.JSX.Element {
  const [value, setValue] = useState(node.title)
  const done = (commit: boolean): void => {
    useApp.getState().setRenaming(null)
    if (commit && value !== node.title) void useApp.getState().renamePage(node.id, value)
  }
  return (
    <input
      className="rename-input"
      autoFocus
      value={value}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => done(true)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') done(true)
        if (e.key === 'Escape') done(false)
      }}
    />
  )
}
