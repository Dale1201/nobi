import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { blocksToMarkdown } from '../core/serialize'
import { mapNotionPaste, notionPageIds, readNotionClipboard } from './paste'
import type { MapContext } from './types'

const CLIPBOARD = join(__dirname, '../../../tests/fixtures/notion-clipboard')

function context(pages: Record<string, string> = {}): MapContext & { issues: string[] } {
  const issues: string[] = []
  return {
    issues,
    link: (href, pageId) => {
      const id = pageId?.replace(/-/g, '')
      return id && pages[id] ? `nobi://page/${pages[id]}` : href
    },
    file: (src) => src,
    issue: (kind, detail) => issues.push(`${kind}: ${detail}`)
  }
}

/** Records in Notion's clipboard format, one top-level block per entry with its descendants. */
function records(
  blocks: Record<string, unknown>[],
  children: Record<string, unknown>[] = []
): string {
  const byId = new Map([...blocks, ...children].map((b) => [b.id as string, b]))
  const subtree = (b: Record<string, unknown>): Record<string, unknown>[] => [
    b,
    ...((b.content as string[] | undefined) ?? []).flatMap((id) => {
      const child = byId.get(id)
      return child ? subtree(child) : []
    })
  ]
  return JSON.stringify({
    blocks: blocks.map((b) => ({
      blockId: b.id,
      blockSubtree: {
        __version__: 3,
        block: Object.fromEntries(subtree(b).map((c) => [c.id, { value: c }]))
      }
    }))
  })
}

describe('mapNotionPaste', () => {
  it('maps the fixture page copied from Notion', async () => {
    const html = readFileSync(join(CLIPBOARD, 'page.html'), 'utf8')
    const json = readFileSync(join(CLIPBOARD, 'records.json'), 'utf8')
    const ctx = context()
    const markdown = blocksToMarkdown(mapNotionPaste({ records: json, html }, ctx))
    await expect(markdown).toMatchFileSnapshot(join(CLIPBOARD, 'expected.md'))
    expect(ctx.issues).toEqual([
      'table: Header column (kept as a normal column)',
      'missingFile: fixture-image.png',
      'missingFile: fixture-report.pdf'
    ])
  })

  it('maps rich text marks, colors and mentions', () => {
    const json = records([
      {
        id: 'a',
        type: 'text',
        properties: {
          title: [
            ['bold', [['b']]],
            [' '],
            ['red', [['h', 'red']]],
            [' '],
            ['green', [['h', 'teal_background']]],
            [' '],
            ['‣', [['p', '11111111-2222-3333-4444-555555555555']]],
            [' '],
            ['‣', [['d', { type: 'date', start_date: '2026-03-14' }]]],
            [' '],
            ['⁍', [['e', 'x^2']]]
          ]
        }
      }
    ])
    const html =
      '<p>bold red green <a href="https://www.notion.so/Plans-11111111222233334444555555555555">Plans</a></p>'
    const ctx = context({ '11111111222233334444555555555555': 'page-1' })
    expect(blocksToMarkdown(mapNotionPaste({ records: json, html }, ctx))).toBe(
      '**bold** <span data-color="red">red</span> <span data-bg="green">green</span> ' +
        '[Plans](nobi://page/page-1 "mention") @March 14, 2026 $x^2$\n'
    )
  })

  it('drops code formatting inside link text, which the editor cannot combine with a link', () => {
    const json = records([
      {
        id: 'a',
        type: 'text',
        properties: { title: [['main.rs', [['c'], ['a', 'https://main.rs']]]] }
      }
    ])
    const html = '<p><a href="https://main.rs"><code>main.rs</code></a></p>'
    expect(blocksToMarkdown(mapNotionPaste({ records: json, html }, context()))).toBe(
      '[main.rs](https://main.rs)\n'
    )
  })

  it('names a mentioned person from the HTML copy', () => {
    const json = records([
      {
        id: 'a',
        type: 'text',
        properties: { title: [['Ask '], ['‣', [['u', 'user-1']]], [' today.']] }
      }
    ])
    const html = '<p>Ask @Ada Lovelace today.</p>'
    expect(blocksToMarkdown(mapNotionPaste({ records: json, html }, context()))).toBe(
      'Ask @Ada Lovelace today.\n'
    )
  })

  it('takes a synced block’s content from the HTML copy', () => {
    const json = records([
      { id: 'a', type: 'text', properties: { title: [['Before']] } },
      { id: 's', type: 'transclusion_container', content: ['missing'] },
      { id: 'b', type: 'text', properties: { title: [['After']] } }
    ])
    const html = '<p>Before</p><p>Synced one</p><ul><li>Synced two</li></ul><p>After</p>'
    expect(blocksToMarkdown(mapNotionPaste({ records: json, html }, context()))).toBe(
      'Before\n\nSynced one\n\n- Synced two\n\nAfter\n'
    )
  })

  it('maps callouts, columns and to-dos', () => {
    const json = records(
      [
        {
          id: 'c',
          type: 'callout',
          format: { page_icon: '🚧', block_color: 'orange_background' },
          content: ['c1']
        },
        { id: 'cl', type: 'column_list', content: ['k1', 'k2'] },
        { id: 't', type: 'to_do', properties: { title: [['Done']], checked: [['Yes']] } }
      ],
      [
        { id: 'c1', type: 'text', properties: { title: [['Careful']] } },
        { id: 'k1', type: 'column', format: { column_ratio: 0.25 }, content: ['p1'] },
        { id: 'k2', type: 'column', format: { column_ratio: 0.75 }, content: ['p2'] },
        { id: 'p1', type: 'text', properties: { title: [['A']] } },
        { id: 'p2', type: 'text', properties: { title: [['B']] } }
      ]
    )
    const markdown = blocksToMarkdown(mapNotionPaste({ records: json }, context()))
    expect(markdown).toContain('> [!callout:orange_bg] 🚧\n> Careful')
    expect(markdown).toContain('<div data-column data-width="0.5">')
    expect(markdown).toContain('<div data-column data-width="1.5">')
    expect(markdown).toContain('- [x] Done')
  })

  it('leaves a note for an uploaded image Notion gives no address for', () => {
    const json = records([
      {
        id: 'i',
        type: 'image',
        properties: { source: [['attachment:abc:photo.png']], title: [['photo.png']] }
      }
    ])
    const ctx = context()
    expect(blocksToMarkdown(mapNotionPaste({ records: json }, ctx))).toBe(
      '*Image from Notion: photo.png*\n'
    )
    expect(ctx.issues).toEqual(['missingFile: photo.png'])
  })

  it('maps a link mention to a link named by its title, or its address', () => {
    const json = records([
      {
        id: 'a',
        type: 'text',
        properties: {
          title: [
            ['See '],
            ['‣', [['lm', { href: 'https://github.com/nb/repo', title: 'nb/repo' }]]],
            [' and '],
            ['‣', [['lm', { href: 'https://example.com/x' }]]]
          ]
        }
      }
    ])
    const html =
      '<p>See <a href="https://github.com/nb/repo">nb/repo</a> and <a href="https://example.com/x">x</a></p>'
    const [block] = mapNotionPaste({ records: json, html }, context())
    expect(block).toMatchObject({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'See ' },
        {
          type: 'link',
          href: 'https://github.com/nb/repo',
          content: [{ type: 'text', text: 'nb/repo' }]
        },
        { type: 'text', text: ' and ' },
        {
          type: 'link',
          href: 'https://example.com/x',
          content: [{ type: 'text', text: 'https://example.com/x' }]
        }
      ]
    })
  })

  it('maps the HTML copy for a mention it does not know', () => {
    const json = records([
      {
        id: 'a',
        type: 'text',
        properties: { title: [['Due '], ['‣', [['rm', { id: 'r1' }]]]] }
      }
    ])
    const html = '<p>Due Tomorrow 9:00</p>'
    expect(blocksToMarkdown(mapNotionPaste({ records: json, html }, context()))).toBe(
      'Due Tomorrow 9:00\n'
    )
  })

  it('keeps the captions of bookmarks, embeds, code, files and media', () => {
    const caption = (text: string): unknown => [[text, [['b']]]]
    const json = records([
      {
        id: 'b',
        type: 'bookmark',
        properties: { link: [['https://a.example']], title: [['A']], caption: caption('Cap b') }
      },
      {
        id: 'e',
        type: 'figma',
        properties: { source: [['https://figma.com/f']], caption: caption('Cap e') }
      },
      {
        id: 'c',
        type: 'code',
        properties: { title: [['x = 1']], language: [['Python']], caption: caption('Cap c') }
      },
      {
        id: 'f',
        type: 'pdf',
        properties: { source: [['https://a.example/r.pdf']], caption: caption('Cap f') }
      },
      {
        id: 'u',
        type: 'file',
        properties: { source: [['attachment:x:notes.txt']], caption: caption('Cap u') }
      },
      {
        id: 'v',
        type: 'video',
        properties: { source: [['https://a.example/v.mp4']], caption: [['Cap v']] }
      },
      { id: 'n', type: 'bookmark', properties: { link: [['https://n.example']] } }
    ])
    const blocks = mapNotionPaste({ records: json }, context())
    const capped = (text: string): object => ({
      type: 'paragraph',
      content: [{ type: 'text', text, styles: { bold: true } }]
    })
    expect(blocks.map((b) => b.type)).toEqual([
      'paragraph',
      'paragraph',
      'paragraph',
      'paragraph',
      'codeBlock',
      'paragraph',
      'paragraph',
      'paragraph',
      'paragraph',
      'paragraph',
      'video',
      'paragraph'
    ])
    expect(blocks[1]).toMatchObject(capped('Cap b'))
    expect(blocks[3]).toMatchObject(capped('Cap e'))
    expect(blocks[5]).toMatchObject(capped('Cap c'))
    expect(blocks[7]).toMatchObject(capped('Cap f'))
    expect(blocks[9]).toMatchObject(capped('Cap u'))
    expect(blocks[10]).toMatchObject({ type: 'video', props: { caption: 'Cap v' } })
  })

  it('falls back to the HTML copy without the records', () => {
    const html = '<!-- notionvc: 1 --><h2>Title</h2><ul><li>One</li></ul>'
    expect(blocksToMarkdown(mapNotionPaste({ html }, context()))).toBe('## Title\n\n- One\n')
  })
})

/** Records from {id: record} maps, with the given ids at the top level. */
function rawRecords(top: string[], all: Record<string, unknown>): string {
  return JSON.stringify({
    blocks: top.map((id) => ({
      blockId: id,
      blockSubtree: {
        block: Object.fromEntries(
          Object.entries(all).map(([key, value]) => [
            key,
            { value: { id: key, ...(value as object) } }
          ])
        )
      }
    }))
  })
}

describe('mapNotionPaste with unreliable records', () => {
  it('maps the HTML copy for a record that contains itself', () => {
    const json = rawRecords(['a'], {
      a: { type: 'text', properties: { title: [['Loop']] }, content: ['a'] }
    })
    expect(
      blocksToMarkdown(mapNotionPaste({ records: json, html: '<p>From HTML</p>' }, context()))
    ).toBe('From HTML\n')
  })

  // Exponential work here shows up as the test timing out, not as a slow pass.
  it('maps the HTML copy, quickly, for blocks shared by many parents', () => {
    const all: Record<string, unknown> = {}
    for (let i = 0; i < 40; i++) {
      all[`n${i}`] = {
        type: 'text',
        properties: { title: [[`L${i}`]] },
        content: [`n${i + 1}`, `n${i + 1}`]
      }
    }
    all.n40 = { type: 'text', properties: { title: [['Leaf']] } }
    const html = '<p>From HTML</p>'
    const markdown = blocksToMarkdown(
      mapNotionPaste({ records: rawRecords(['n0'], all), html }, context())
    )
    expect(markdown).toBe('From HTML\n')
  })

  it('treats malformed content, rich text and marks as empty', () => {
    const json = rawRecords(['a', 'b', 'c', 'd'], {
      a: { type: 'text', content: 'x', properties: { title: [['Fine']] } },
      b: { type: 'text', properties: { title: 'x' } },
      c: {
        type: 'text',
        format: 'x',
        properties: { title: [null, ['x', 5], [7, [['b']]], ['y', ['b']], ['z', [['h', 5]]]] }
      },
      d: { type: 'table', format: { table_block_column_order: 'x' }, content: 'y' }
    })
    expect(() => mapNotionPaste({ records: json }, context())).not.toThrow()
    expect(blocksToMarkdown(mapNotionPaste({ records: json }, context()))).toContain('Fine')
  })

  it('maps the HTML copy when mapping the records throws', () => {
    const json = records([
      { id: 'a', type: 'text', properties: { title: [['x', [['a', 'https://example.com']]]] } }
    ])
    const ctx = {
      ...context(),
      link: (href: string) => {
        if (href === 'https://example.com') throw new Error('boom')
        return href
      }
    }
    expect(blocksToMarkdown(mapNotionPaste({ records: json, html: '<p>From HTML</p>' }, ctx))).toBe(
      'From HTML\n'
    )
  })

  it('maps the HTML copy when a nested block has no record', () => {
    const json = records([
      { id: 't', type: 'toggle', properties: { title: [['Toggle']] }, content: ['gone'] }
    ])
    expect(
      blocksToMarkdown(mapNotionPaste({ records: json, html: '<p>From HTML</p>' }, context()))
    ).toBe('From HTML\n')
  })

  it('keeps a top-level block without a record as a link to its page', () => {
    const id = '11111111222233334444555555555555'
    const json = JSON.stringify({ blocks: [{ blockId: id }] })
    const html = `<p><a href="https://www.notion.so/Plans-${id}">Plans</a></p>`
    expect(blocksToMarkdown(mapNotionPaste({ records: json, html }, context()))).toBe(
      `[Plans](https://www.notion.so/${id})\n`
    )
  })

  it('maps the HTML copy when the records hold no blocks', () => {
    expect(
      blocksToMarkdown(
        mapNotionPaste({ records: '{"blocks":[]}', html: '<p>From HTML</p>' }, context())
      )
    ).toBe('From HTML\n')
  })
})

describe('person mentions', () => {
  const mention = (id: string): [string, [string, string][]] => ['‣', [['u', id]]]

  it('names a person mentioned at the end of a block', () => {
    const json = records([
      { id: 'a', type: 'text', properties: { title: [['Ask '], mention('u1')] } }
    ])
    expect(
      blocksToMarkdown(
        mapNotionPaste({ records: json, html: '<p>Ask @Ada Lovelace</p>' }, context())
      )
    ).toBe('Ask @Ada Lovelace\n')
  })

  it('gives each of two similar blocks its own person', () => {
    const json = records([
      { id: 'a', type: 'text', properties: { title: [['Ask '], mention('u1'), [' today.']] } },
      { id: 'b', type: 'text', properties: { title: [['Ask '], mention('u2'), [' today.']] } }
    ])
    const html = '<p>Ask @Ada today.</p><p>Ask @Bob today.</p>'
    expect(blocksToMarkdown(mapNotionPaste({ records: json, html }, context()))).toBe(
      'Ask @Ada today.\n\nAsk @Bob today.\n'
    )
  })

  it('keeps a name when a space follows the mention', () => {
    const json = records([
      { id: 'a', type: 'text', properties: { title: [['Ask '], mention('u1'), [' ']] } }
    ])
    expect(
      blocksToMarkdown(
        mapNotionPaste({ records: json, html: '<p>Ask @Ada Lovelace </p>' }, context())
      )
    ).toContain('@Ada Lovelace')
  })

  it('does not guess a name when another mention follows directly', () => {
    const json = records([
      {
        id: 'a',
        type: 'text',
        properties: {
          title: [['Ask '], mention('u1'), ['‣', [['d', { start_date: '2026-03-14' }]]]]
        }
      }
    ])
    const markdown = blocksToMarkdown(
      mapNotionPaste({ records: json, html: '<p>Ask @Ada Lovelace@March 14, 2026</p>' }, context())
    )
    expect(markdown).toContain('@Someone')
    expect(markdown).not.toContain('@A ')
  })

  it('keeps names matched to the right blocks around a synced block', () => {
    const json = records([
      { id: 'a', type: 'text', properties: { title: [['Ask '], mention('u1'), [' today.']] } },
      { id: 's', type: 'transclusion_container', content: ['missing'] },
      { id: 'b', type: 'text', properties: { title: [['Ask '], mention('u2'), [' today.']] } }
    ])
    const html = '<p>Ask @Ada today.</p><p>Synced</p><p>Ask @Bob today.</p>'
    expect(blocksToMarkdown(mapNotionPaste({ records: json, html }, context()))).toBe(
      'Ask @Ada today.\n\nSynced\n\nAsk @Bob today.\n'
    )
  })

  it('gives up quickly on mentions that match nothing in a long page', () => {
    const rich = [
      mention('1'),
      [' x '],
      mention('2'),
      [' y '],
      mention('3'),
      [' z '],
      mention('4'),
      [' END']
    ]
    const json = records([{ id: 'a', type: 'text', properties: { title: rich } }])
    const html = `<p>${'@a x @b y @c z @d '.repeat(100)}</p>`.repeat(6)
    expect(blocksToMarkdown(mapNotionPaste({ records: json, html }, context()))).toContain('END')
  })
})

describe('synced blocks next to blocks without text', () => {
  it('does not repeat a divider or the page around the synced content', () => {
    const json = records([
      { id: 'd', type: 'divider' },
      { id: 's', type: 'transclusion_container', content: ['missing'] },
      { id: 'b', type: 'text', properties: { title: [['After']] } }
    ])
    const html = '<hr><p>Synced</p><p>After</p>'
    expect(blocksToMarkdown(mapNotionPaste({ records: json, html }, context()))).toBe(
      '---\n\nSynced\n\nAfter\n'
    )
  })
})

describe('readNotionClipboard', () => {
  const data = (entries: Record<string, string>): Pick<DataTransfer, 'getData' | 'types'> => ({
    types: Object.keys(entries),
    getData: (type: string) => entries[type] ?? ''
  })

  it('recognizes Notion’s records or its HTML marker, and nothing else', () => {
    expect(
      readNotionClipboard(
        data({ 'text/_notion-blocks-v3-production': '{}', 'text/html': '<p>x</p>' })
      )
    ).toEqual({ records: '{}', html: '<p>x</p>' })
    expect(readNotionClipboard(data({ 'text/html': '<p>x</p><!-- notionvc: 1 -->' }))).toEqual({
      html: '<p>x</p><!-- notionvc: 1 -->'
    })
    expect(readNotionClipboard(data({ 'text/html': '<p>x</p>', 'text/plain': 'x' }))).toBeNull()
  })

  it('lists the Notion page ids a copy mentions', () => {
    expect(
      notionPageIds({
        records: '"11111111-2222-3333-4444-555555555555"',
        html: '<a href="https://www.notion.so/X-66666666777788889999aaaaaaaaaaaa">'
      })
    ).toEqual(['11111111222233334444555555555555', '66666666777788889999aaaaaaaaaaaa'])
  })
})
