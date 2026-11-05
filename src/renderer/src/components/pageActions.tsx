import { emitPageEvent } from '../lib/pageEvents'
import { useApp } from '../store'
import {
  DuplicateIcon,
  FolderIcon,
  LinkIcon,
  MoveIcon,
  OpenInTabIcon,
  RenameIcon,
  StarIcon,
  TrashIcon
} from './icons'
import type { MenuItemEntry } from './menu/model'

const app = useApp.getState
const api = window.api

/** Notion's shortcuts, shown as hints; pressing one runs its item while the menu is open. */
export const SHORTCUTS = {
  duplicate: '⌘D',
  rename: '⌘⇧R',
  moveTo: '⌘⇧P',
  openInTab: '⌘⇧↵',
  askAi: '⌘J',
  delete: 'Del'
}

export function favoriteEntry(id: string, isFavorite: boolean): MenuItemEntry {
  return {
    kind: 'item',
    id: 'favorite',
    label: isFavorite ? 'Remove from Favorites' : 'Add to Favorites',
    icon: <StarIcon size={16} filled={isFavorite} />,
    onSelect: () => void app().toggleFavorite(id)
  }
}

export function duplicatePageEntry(id: string, options?: { open?: boolean }): MenuItemEntry {
  return {
    kind: 'item',
    id: 'duplicate',
    label: 'Duplicate',
    hint: SHORTCUTS.duplicate,
    icon: <DuplicateIcon size={16} />,
    onSelect: () => void app().duplicatePage(id, options)
  }
}

export function renameEntry(onSelect: () => void): MenuItemEntry {
  return {
    kind: 'item',
    id: 'rename',
    label: 'Rename',
    hint: SHORTCUTS.rename,
    icon: <RenameIcon size={16} />,
    onSelect
  }
}

export function moveToEntry(id: string): MenuItemEntry {
  return {
    kind: 'item',
    id: 'move',
    label: 'Move to',
    hint: SHORTCUTS.moveTo,
    icon: <MoveIcon size={16} />,
    onSelect: () => app().setOverlay({ kind: 'move', pageId: id })
  }
}

export function trashEntry(id: string): MenuItemEntry {
  return {
    kind: 'item',
    id: 'delete',
    label: 'Move to Trash',
    keywords: ['delete', 'remove'],
    icon: <TrashIcon size={16} />,
    danger: true,
    onSelect: () => void app().trashPage(id)
  }
}

export function openInTabEntry(id: string): MenuItemEntry {
  return {
    kind: 'item',
    id: 'open-tab',
    label: 'Open in new tab',
    hint: SHORTCUTS.openInTab,
    icon: <OpenInTabIcon size={16} />,
    onSelect: () => app().openPage(id, { tab: 'foreground' })
  }
}

export function revealEntry(id: string): MenuItemEntry {
  return {
    kind: 'item',
    id: 'reveal',
    label: 'Reveal in Finder',
    keywords: ['show', 'open', 'folder', 'explorer'],
    icon: <FolderIcon size={16} />,
    onSelect: () =>
      void api.invoke('page:reveal', { id }).catch((e) => app().reportError('reveal', e))
  }
}

export function copyPathEntry(id: string): MenuItemEntry {
  return {
    kind: 'item',
    id: 'copy-path',
    label: 'Copy file path',
    keywords: ['link', 'location'],
    icon: <LinkIcon size={16} />,
    onSelect: () =>
      void api
        .invoke('page:copyPath', { id })
        .catch((e) => app().reportError('copy the path of', e))
  }
}

/** Sets the icon of a page that may not be open; tabs showing it follow once it is saved. */
export function setPageIcon(id: string, icon: string | null): void {
  const patch = { icon }
  api.invoke('page:meta', { id, patch }).then(
    () => emitPageEvent({ type: 'meta', id, patch }),
    (e) => app().reportError('update', e)
  )
}
