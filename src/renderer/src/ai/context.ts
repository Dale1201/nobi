import { nodeToBlock, type BlockNoteEditor } from '@blocknote/core'
import { NodeSelection, type EditorState } from 'prosemirror-state'
import { CURSOR, SELECTION_END, SELECTION_START } from '@shared/ai'
import type { Block } from '@shared/core/blocks'
import { blocksToMarkdown, type SerializeOptions } from '@shared/core/serialize'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyEditor = BlockNoteEditor<any, any, any>

const PLACEHOLDERS: Record<string, string> = {
  image: '[image]',
  video: '[video]',
  audio: '[audio]',
  file: '[file]',
  drawing: '[drawing]'
}

// Raw blocks are written out as they are, so the brackets are not escaped.
const marker = (markdown: string): Block => ({ type: 'raw', props: { markdown }, children: [] })

/** Media is named, never sent: its files stay on this Mac. */
function withoutMedia(blocks: Block[]): Block[] {
  return blocks.map((block) => {
    const name = PLACEHOLDERS[block.type]
    if (name) return { ...marker(name), id: block.id } as Block
    return { ...block, children: withoutMedia(block.children) } as Block
  })
}

function wrapBlocks(blocks: Block[], ids: Set<string>): Block[] {
  const first = blocks.findIndex((b) => ids.has(b.id!))
  if (first === -1)
    return blocks.map((b) => ({ ...b, children: wrapBlocks(b.children, ids) }) as Block)
  let last = first
  while (last + 1 < blocks.length && ids.has(blocks[last + 1].id!)) last++
  return [
    ...blocks.slice(0, first),
    marker(SELECTION_START),
    ...blocks.slice(first, last + 1),
    marker(SELECTION_END),
    ...blocks.slice(last + 1)
  ]
}

/** The block whose content is node-selected, as when an image is clicked. */
export function nodeSelectedBlock(state: EditorState): string | null {
  const { selection } = state
  if (!(selection instanceof NodeSelection)) return null
  const parent = selection.$from.parent
  return parent.type.name === 'blockContainer' ? (parent.attrs.id as string) : null
}

function insertAfter(blocks: Block[], id: string, block: Block): Block[] {
  const i = blocks.findIndex((b) => b.id === id)
  if (i !== -1) return [...blocks.slice(0, i + 1), block, ...blocks.slice(i + 1)]
  return blocks.map((b) => ({ ...b, children: insertAfter(b.children, id, block) }) as Block)
}

/**
 * The page as Markdown, with the text selection, the selected blocks or the cursor marked,
 * for Claude to read.
 */
export function pageMarkdown(
  editor: AnyEditor,
  mark: { selectedBlocks: string[] } | { cursor: true } | { selection: true },
  pageTitle?: SerializeOptions['pageTitle']
): string {
  const state = editor.prosemirrorState
  const tr = state.tr
  // A selected node such as an image takes no text, so the cursor goes after its block.
  const after = 'cursor' in mark ? nodeSelectedBlock(state) : null
  if ('selection' in mark) {
    tr.insertText(SELECTION_END, state.selection.to)
    tr.insertText(SELECTION_START, state.selection.from)
  } else if ('cursor' in mark && !after) {
    tr.insertText(CURSOR, state.selection.from)
  }
  let blocks: Block[] = []
  tr.doc.firstChild!.forEach((node) => {
    blocks.push(nodeToBlock(node, tr.doc) as unknown as Block)
  })
  if (after) blocks = insertAfter(blocks, after, marker(CURSOR))
  if ('selectedBlocks' in mark) blocks = wrapBlocks(blocks, new Set(mark.selectedBlocks))
  return blocksToMarkdown(withoutMedia(blocks), { pageTitle })
}
