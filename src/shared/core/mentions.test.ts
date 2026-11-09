import { describe, expect, it } from 'vitest'
import type { Block } from './blocks'
import { mapBlockLinks, refreshMentionTitles } from './links'
import { markdownToBlocks } from './parse'
import { blocksToMarkdown } from './serialize'
import { blocksText } from './text'

const mention = (href: string, title: string): Block => ({
  type: 'paragraph',
  props: {},
  content: [
    { type: 'text', text: 'See ', styles: {} },
    { type: 'pageMention', props: { href, title } }
  ],
  children: []
})

describe('page mentions', () => {
  it('read and write as a link titled "mention"', () => {
    const md = 'See [Plans](Notes/Plans.md "mention")\n'
    expect(markdownToBlocks(md)).toEqual([mention('Notes/Plans.md', 'Plans')])
    expect(blocksToMarkdown([mention('Notes/Plans.md', 'Plans')])).toBe(md)
  })

  it('leave other links alone', () => {
    expect(markdownToBlocks('[Plans](Notes/Plans.md)\n')[0].content).toEqual([
      {
        type: 'link',
        href: 'Notes/Plans.md',
        content: [{ type: 'text', text: 'Plans', styles: {} }]
      }
    ])
  })

  it('count as text for search', () => {
    expect(blocksText([mention('x.md', 'Plans')])).toContain('Plans')
  })

  it('follow link rewriting', () => {
    const [moved] = mapBlockLinks([mention('Old.md', 'Plans')], () => 'New.md')
    expect(moved.content).toContainEqual({
      type: 'pageMention',
      props: { href: 'New.md', title: 'Plans' }
    })
  })

  it('take the current title of their page', () => {
    const [fresh] = refreshMentionTitles([mention('nobi://page/1', 'Old')], (href) =>
      href === 'nobi://page/1' ? 'New' : undefined
    )
    expect(fresh.content).toContainEqual({
      type: 'pageMention',
      props: { href: 'nobi://page/1', title: 'New' }
    })
  })

  it('work inside table cells', () => {
    const table: Block = {
      type: 'table',
      props: {},
      content: {
        type: 'tableContent',
        rows: [{ cells: [[{ type: 'pageMention', props: { href: 'a.md', title: 'A' } }]] }]
      },
      children: []
    }
    const [moved] = mapBlockLinks([table], () => 'b.md')
    expect(JSON.stringify(moved)).toContain('"href":"b.md"')
  })
})
