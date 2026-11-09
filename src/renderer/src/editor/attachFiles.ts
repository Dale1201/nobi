import type { Block, Inline } from '@shared/core/blocks'
import type { AppEditor, AppPartialBlock } from './schema'

type AppInlineContent = Parameters<AppEditor['insertInlineContent']>[0]

/** Window event asking the open editor to attach dropped files at the cursor. */
export const ATTACH_FILES_EVENT = 'nobi:attach-files'

/** Puts blocks after the cursor's block, or in its place when that block is an empty paragraph. */
export function insertAtCursor(editor: AppEditor, blocks: Block[]): void {
  if (blocks.length === 0) return
  const partial = blocks as unknown as AppPartialBlock[]
  const cursor = editor.getTextCursorPosition().block
  const empty =
    cursor.type === 'paragraph' &&
    Array.isArray(cursor.content) &&
    cursor.content.length === 0 &&
    cursor.children.length === 0
  if (empty) editor.replaceBlocks([cursor], partial)
  else editor.insertBlocks(partial, cursor, 'after')
}

/** Pastes `text` as one paragraph per non-empty line. */
export function insertPlainText(editor: AppEditor, text: string): void {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '')
  insertAtCursor(
    editor,
    lines.map((line) => ({
      type: 'paragraph',
      props: {},
      content: [{ type: 'text', text: line, styles: {} }],
      children: []
    }))
  )
}

/** A paste of one plain paragraph is a phrase: its text goes into the text at the cursor. */
export function inlinePaste(blocks: Block[]): Inline[] | null {
  if (blocks.length !== 1) return null
  const [block] = blocks
  if (block.type !== 'paragraph' || block.children.length > 0) return null
  const colors: (string | undefined)[] = Object.values(block.props)
  const plain = colors.every((value) => value === undefined || value === 'default')
  return plain ? block.content : null
}

/** Puts a phrase into the text at the cursor, and other blocks after the cursor's block. */
export function insertPasted(editor: AppEditor, blocks: Block[]): void {
  const inline = inlinePaste(blocks)
  if (inline) {
    editor.insertInlineContent(inline as unknown as AppInlineContent, { updateSelection: true })
    return
  }
  editor.transact((tr) => {
    if (!tr.selection.empty) tr.deleteSelection()
  })
  insertAtCursor(editor, blocks)
}

/** Code blocks and tables take any paste as plain text at the cursor; false elsewhere. */
export function pasteAsText(editor: AppEditor, text: string): boolean {
  if (text === '') return false
  const { type } = editor.getTextCursorPosition().block
  if (type === 'codeBlock') return editor.pasteText(text)
  if (type !== 'table') return false
  editor.insertInlineContent(text, { updateSelection: true })
  return true
}
