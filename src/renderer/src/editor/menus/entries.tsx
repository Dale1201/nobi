import { COLOR_NAMES } from '@shared/core/blocks'
import { openWriter } from '../../ai/writerRegistry'
import {
  DuplicateIcon,
  PaletteIcon,
  SmileIcon,
  SparkleIcon,
  TrashIcon,
  TurnIntoIcon
} from '../../components/icons'
import type { MenuEntry } from '../../components/menu/model'
import {
  copyPathEntry,
  duplicatePageEntry,
  favoriteEntry,
  moveToEntry,
  openInTabEntry,
  renameEntry,
  revealEntry,
  SHORTCUTS,
  trashEntry
} from '../../components/pageActions'
import { findNode, pageIdForHref, parentOf } from '../../lib/tree'
import { useApp } from '../../store'
import { colorBlocks, deleteBlocks, duplicateBlocks, turnIntoBlocks } from '../blockActions'
import { selectBlocks } from '../blockSelection'
import type { AppBlock, AppEditor } from '../schema'
import { canTurnInto, currentTurnInto, TURN_INTO } from '../turnInto'

const NAMES: Record<string, string> = {
  image: 'Image',
  video: 'Video',
  audio: 'Audio',
  file: 'File',
  drawing: 'Drawing',
  table: 'Table',
  divider: 'Divider',
  pageLink: 'Page',
  toc: 'Table of contents',
  columnList: 'Columns',
  column: 'Column',
  raw: 'Markdown'
}

const capital = (s: string): string => s[0].toUpperCase() + s.slice(1)

export function blockLabel(block: AppBlock): string {
  const id = currentTurnInto(block)
  return (id && TURN_INTO.find((o) => o.id === id)?.label) || NAMES[block.type] || 'Block'
}

export function turnIntoEntries(editor: AppEditor, blocks: AppBlock[]): MenuEntry[] {
  const current = blocks.length === 1 ? currentTurnInto(blocks[0]) : null
  const ids = blocks.map((b) => b.id)
  return TURN_INTO.map((option) => ({
    kind: 'item',
    id: `turn-${option.id}`,
    label: option.label,
    hint: option.hint,
    checked: option.id === current,
    onSelect: () => turnIntoBlocks(editor, ids, option.id)
  }))
}

export function colorEntries(editor: AppEditor, blocks: AppBlock[]): MenuEntry[] {
  const ids = blocks.map((b) => b.id)
  const text = (color: string, label: string): MenuEntry => ({
    kind: 'item',
    id: `text-${color}`,
    label,
    keywords: ['color', 'text'],
    icon: (
      <span className="menu-color" data-text={color}>
        A
      </span>
    ),
    onSelect: () => colorBlocks(editor, ids, 'textColor', color)
  })
  const background = (color: string, label: string): MenuEntry => ({
    kind: 'item',
    id: `bg-${color}`,
    label,
    keywords: ['color'],
    icon: <span className="menu-color" data-bg={color} />,
    onSelect: () => colorBlocks(editor, ids, 'backgroundColor', color)
  })
  return [
    { kind: 'section', label: 'Text color' },
    text('default', 'Default'),
    ...COLOR_NAMES.map((c) => text(c, capital(c))),
    { kind: 'section', label: 'Background color' },
    background('default', 'Default background'),
    ...COLOR_NAMES.map((c) => background(c, `${capital(c)} background`))
  ]
}

export interface BlockMenuOptions {
  /** The page this editor shows; blocks for its own sub-pages act on those pages. */
  pageId?: string
  ai: { shown: boolean; online: boolean }
  editIcon(pageId: string, blockId: string): void
  rename(pageId: string, blockId: string): void
}

/** The page a page block points to, when it is a sub-page of `parentId`, as Notion's page blocks are. */
function subPageOf(block: AppBlock, parentId: string | undefined): string | null {
  if (block.type !== 'pageLink' || !parentId) return null
  const tree = useApp.getState().tree
  const id = pageIdForHref(tree, block.props.href)
  return id && parentOf(tree, id)?.id === parentId ? id : null
}

function linkedPageOf(block: AppBlock): string | null {
  if (block.type !== 'pageLink') return null
  const tree = useApp.getState().tree
  const id = pageIdForHref(tree, block.props.href)
  return id && findNode(tree, id) ? id : null
}

function askAiEntries(editor: AppEditor, ids: string[], options: BlockMenuOptions): MenuEntry[] {
  if (!options.ai.shown) return []
  return [
    { kind: 'separator' },
    {
      kind: 'item',
      id: 'ask-ai',
      label: 'Ask AI',
      hint: SHORTCUTS.askAi,
      icon: <SparkleIcon size={16} />,
      disabled: !options.ai.online,
      onSelect: () => {
        // The menu cleared the block selection as it closed; the Writer works on it.
        selectBlocks(editor, ids)
        openWriter(editor)
      }
    }
  ]
}

function pageBlockEntries(
  editor: AppEditor,
  block: AppBlock,
  pageId: string,
  options: BlockMenuOptions
): MenuEntry[] {
  return [
    {
      kind: 'item',
      id: 'edit-icon',
      label: 'Edit icon',
      icon: <SmileIcon size={16} />,
      onSelect: () => options.editIcon(pageId, block.id)
    },
    favoriteEntry(pageId, useApp.getState().favorites.includes(pageId)),
    renameEntry(() => options.rename(pageId, block.id)),
    { kind: 'separator' },
    openInTabEntry(pageId),
    revealEntry(pageId),
    copyPathEntry(pageId),
    { kind: 'separator' },
    duplicatePageEntry(pageId, { open: false }),
    moveToEntry(pageId),
    trashEntry(pageId),
    ...askAiEntries(editor, [block.id], options)
  ]
}

export function blockMenuEntries(
  editor: AppEditor,
  blocks: AppBlock[],
  options: BlockMenuOptions
): MenuEntry[] {
  const ids = blocks.map((b) => b.id)
  const subPage = blocks.length === 1 ? subPageOf(blocks[0], options.pageId) : null
  if (subPage) return pageBlockEntries(editor, blocks[0], subPage, options)
  const entries: MenuEntry[] = []
  if (blocks.every(canTurnInto)) {
    entries.push({
      kind: 'item',
      id: 'turn-into',
      label: 'Turn into',
      icon: <TurnIntoIcon size={16} />,
      submenu: turnIntoEntries(editor, blocks)
    })
  }
  if (blocks.every((b) => 'textColor' in b.props || 'backgroundColor' in b.props)) {
    entries.push({
      kind: 'item',
      id: 'color',
      label: 'Color',
      icon: <PaletteIcon size={16} />,
      submenu: colorEntries(editor, blocks)
    })
  }
  const linked = blocks.length === 1 ? linkedPageOf(blocks[0]) : null
  if (linked) entries.push(openInTabEntry(linked))
  if (entries.length) entries.push({ kind: 'separator' })
  entries.push(
    {
      kind: 'item',
      id: 'duplicate',
      label: 'Duplicate',
      hint: SHORTCUTS.duplicate,
      icon: <DuplicateIcon size={16} />,
      onSelect: () => duplicateBlocks(editor, ids)
    },
    {
      kind: 'item',
      id: 'delete',
      label: 'Delete',
      hint: SHORTCUTS.delete,
      danger: true,
      icon: <TrashIcon size={16} />,
      onSelect: () => deleteBlocks(editor, ids)
    },
    ...askAiEntries(editor, ids, options)
  )
  return entries
}
