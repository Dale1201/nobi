// @vitest-environment happy-dom
import { BlockNoteEditor, type PartialBlock } from '@blocknote/core'
import { NodeSelection, TextSelection } from 'prosemirror-state'
import { expect, it } from 'vitest'
import { schema } from '../editor/schema'
import { pageMarkdown } from './context'

function editorWith(blocks: PartialBlock[]): BlockNoteEditor {
  const editor = BlockNoteEditor.create({ initialContent: blocks })
  editor.mount(document.createElement('div'))
  return editor
}

const page = (): PartialBlock[] => [
  { id: 'a', type: 'heading', props: { level: 2 }, content: 'Plan' },
  { id: 'b', type: 'paragraph', content: 'Launch in November.' },
  { id: 'c', type: 'image', props: { url: 'attachments/chart.png' } },
  {
    id: 'd',
    type: 'bulletListItem',
    content: 'QA',
    children: [{ id: 'e', type: 'file', props: { url: 'attachments/spec.pdf' } }]
  }
]

function select(editor: BlockNoteEditor, text: string): void {
  let from = -1
  editor.prosemirrorState.doc.descendants((node, pos) => {
    const i = node.isText ? node.text!.indexOf(text) : -1
    if (from === -1 && i !== -1) from = pos + i
    return from === -1
  })
  editor.transact((tr) => tr.setSelection(TextSelection.create(tr.doc, from, from + text.length)))
}

it('marks the selected text inside the page', () => {
  const editor = editorWith(page())
  select(editor, 'in Novem')
  expect(pageMarkdown(editor, { selection: true })).toBe(
    '## Plan\n\nLaunch ⟦selection⟧in Novem⟦/selection⟧ber.\n\n[image]\n\n- QA\n\n  [file]\n'
  )
  // Reading the page changes nothing in the editor.
  expect(editor.document[1].content).toEqual([
    { type: 'text', text: 'Launch in November.', styles: {} }
  ])
})

it('marks the cursor', () => {
  const editor = editorWith(page())
  editor.setTextCursorPosition('b', 'end')
  expect(pageMarkdown(editor, { cursor: true })).toContain('Launch in November.⟦cursor⟧')
})

it('marks the cursor after a node-selected block, such as a clicked image', () => {
  const editor = editorWith(page())
  let at = -1
  editor.prosemirrorState.doc.descendants((node, pos) => {
    if (node.type.name === 'image') at = pos
    return at === -1
  })
  editor.transact((tr) => tr.setSelection(NodeSelection.create(tr.doc, at)))
  expect(pageMarkdown(editor, { cursor: true })).toBe(
    '## Plan\n\nLaunch in November.\n\n[image]\n\n⟦cursor⟧\n\n- QA\n\n  [file]\n'
  )
})

it('wraps selected blocks, and never sends media', () => {
  const editor = editorWith(page())
  const markdown = pageMarkdown(editor, { selectedBlocks: ['b', 'c'] })
  expect(markdown).toBe(
    '## Plan\n\n⟦selection⟧\n\nLaunch in November.\n\n[image]\n\n⟦/selection⟧\n\n- QA\n\n  [file]\n'
  )
  expect(markdown).not.toContain('attachments/')
})

it('names a page block by the title of the page it links to', () => {
  const editor = BlockNoteEditor.create({
    schema,
    initialContent: [{ type: 'pageLink', props: { href: 'nobi://page/p1' } }]
  })
  editor.mount(document.createElement('div'))
  const titles: Record<string, string> = { 'nobi://page/p1': 'Launch plan' }
  expect(pageMarkdown(editor, { cursor: true }, (href) => titles[href])).toContain(
    '[Launch plan](nobi://page/p1 "page")'
  )
})
