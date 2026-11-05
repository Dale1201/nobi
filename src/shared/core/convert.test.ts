import { describe, expect, it } from 'vitest'
import type { Block } from './blocks'
import { closeContainers, markdownToBlocks } from './parse'
import { blocksToMarkdown } from './serialize'
import { normalizeBlocks } from './normalize'

const roundTrip = (md: string): string => blocksToMarkdown(markdownToBlocks(md))

describe('canonical markdown survives a round trip', () => {
  const cases: Record<string, string> = {
    paragraph: 'Hello world\n',
    headings: '# One\n\n## Two\n\n### Three\n',
    marks: 'a **bold** *italic* ~~strike~~ `code` [link](https://example.com)\n',
    nestedMarks: '**bold *both*** plain\n',
    underlineAndColor:
      'x <u>under</u> <span data-color="red">red</span> <span data-bg="yellow">hi</span>\n',
    blockColor: 'Colored<!-- color=red bg=yellow -->\n',
    emptyParagraph: 'a\n\n&nbsp;\n\nb\n',
    hardBreak: 'line one\\\nline two\n',
    bullets: '- one\n- two\n  - nested\n',
    numbered: '1. one\n2. two\n',
    numberedStart: '3. three\n4. four\n',
    todos: '- [ ] open\n- [x] done\n',
    toggle: '<details>\n<summary>Title **bold**</summary>\n\nInside\n\n</details>\n',
    toggleHeading: '<details data-heading="2">\n<summary>Section</summary>\n\nBody\n\n</details>\n',
    quote: '> quoted\n',
    callout: '> [!callout] 💡\n> Note this\n',
    calloutColors: '> [!callout:red:blue_bg] 🚀\n> Launch\n',
    calloutChildren: '> [!callout] 💡\n> Lead\n>\n> - item\n',
    calloutNoIcon: '> [!callout]\n> Plain\n',
    calloutImageIcon: '> [!callout] /attachments/my%20icon.png\n> Custom\n',
    divider: 'a\n\n---\n\nb\n',
    code: '```ts\nconst a = 1\n```\n',
    codeNoLang: '```\nplain\n```\n',
    math: '$$\nE = mc^2\n$$\n',
    inlineMath: 'Euler $e^{i\\pi}$ wow\n',
    table: '| a | b |\n| - | - |\n| 1 | 2 |\n',
    image: '![A cat](attachments/cat.png)\n',
    drawing: '![](attachments/Drawing%20\\(2\\).excalidraw.svg)\n',
    imageWidth: '<img src="attachments/cat.png" alt="A cat" width="320">\n',
    video: '<video src="attachments/clip.mp4" controls></video>\n',
    file: '[report.pdf](attachments/report.pdf "file")\n',
    pageLink: '[Website Redesign](Projects/Website%20Redesign.md "page")\n',
    columns:
      '<div data-columns>\n\n<div data-column>\n\nLeft\n\n</div>\n\n<div data-column data-width="2">\n\nRight\n\n</div>\n\n</div>\n',
    paragraphChildren: 'Parent\n\n<div data-children>\n\nChild\n\n</div>\n',
    toc: '# Intro\n\n<nav data-toc></nav>\n\n## Part\n',
    raw: '<section>custom</section>\n',
    footnote: 'Text[^1]\n\n[^1]: The note\n'
  }
  for (const [name, md] of Object.entries(cases)) {
    it(name, () => expect(roundTrip(md)).toBe(md))
  }
})

describe('markdownToBlocks structure', () => {
  it('parses marks into styles', () => {
    expect(markdownToBlocks('**b** <u>u</u> <span data-color="red">r</span>')).toEqual([
      {
        type: 'paragraph',
        props: {},
        content: [
          { type: 'text', text: 'b', styles: { bold: true } },
          { type: 'text', text: ' ', styles: {} },
          { type: 'text', text: 'u', styles: { underline: true } },
          { type: 'text', text: ' ', styles: {} },
          { type: 'text', text: 'r', styles: { textColor: 'red' } }
        ],
        children: []
      }
    ])
  })

  it('parses a table of contents marker into a toc block', () => {
    expect(markdownToBlocks('<nav data-toc></nav>\n')).toEqual([
      { type: 'toc', props: {}, children: [] }
    ])
  })

  it('parses a callout with colors and children', () => {
    const [callout] = markdownToBlocks('> [!callout:blue_bg] 🚀\n> Lead\n>\n> Child\n')
    expect(callout).toMatchObject({
      type: 'callout',
      props: { icon: '🚀', backgroundColor: 'blue' },
      content: [{ type: 'text', text: 'Lead', styles: {} }],
      children: [{ type: 'paragraph', content: [{ type: 'text', text: 'Child' }] }]
    })
  })

  it('parses toggles, columns and list nesting', () => {
    const blocks = markdownToBlocks(
      '- a\n  - b\n\n<div data-columns>\n\n<div data-column>\n\n<details>\n<summary>T</summary>\n\n- inner\n\n</details>\n\n</div>\n\n<div data-column>\n\nR\n\n</div>\n\n</div>\n'
    )
    expect(blocks[0]).toMatchObject({
      type: 'bulletListItem',
      children: [{ type: 'bulletListItem' }]
    })
    expect(blocks[1]).toMatchObject({
      type: 'columnList',
      children: [
        {
          type: 'column',
          props: { width: 1 },
          children: [{ type: 'toggleListItem', children: [{ type: 'bulletListItem' }] }]
        },
        { type: 'column', children: [{ type: 'paragraph' }] }
      ]
    })
  })

  it('keeps code exclusive of other marks', () => {
    const [p] = markdownToBlocks('**`x`**')
    expect(p).toMatchObject({ content: [{ type: 'text', text: 'x', styles: { code: true } }] })
  })

  it('moves edge whitespace outside delimiter marks', () => {
    const md = blocksToMarkdown([
      {
        type: 'paragraph',
        props: {},
        content: [{ type: 'text', text: ' x ', styles: { bold: true } }],
        children: []
      }
    ])
    expect(md).toBe('&#x20;**x**&#x20;\n')
  })

  it('treats empty input as an empty document', () => {
    expect(markdownToBlocks('')).toEqual([])
    expect(blocksToMarkdown([])).toBe('')
  })

  it('preserves unknown markdown as a raw block', () => {
    expect(markdownToBlocks('<section>custom</section>')).toEqual([
      { type: 'raw', props: { markdown: '<section>custom</section>' }, children: [] }
    ])
  })

  it('keeps unmatched container tags as raw blocks', () => {
    const blocks = markdownToBlocks('<div data-columns>\n\nNo close\n')
    expect(blocks[0]).toMatchObject({ type: 'raw' })
    expect(blocks[1]).toMatchObject({ type: 'paragraph' })
  })

  it('closes the columns and toggles that Markdown cut off part way has opened', () => {
    const cut =
      '<div data-columns>\n\n<div data-column>\n\nA\n\n</div>\n\n<div data-column>\n\n<details>\n<summary>T</summary>\n\nIn'
    expect(closeContainers(cut)).toBe(`${cut}\n\n</details>\n\n</div>\n\n</div>\n`)
    expect(markdownToBlocks(closeContainers(cut))).toMatchObject([
      { type: 'columnList', children: [{ type: 'column' }, { type: 'column' }] }
    ])
    const whole = '<div data-columns>\n\n<div data-column>\n\nA\n\n</div>\n\n</div>\n'
    expect(closeContainers(whole)).toBe(whole)
    const code = '```html\n<div data-columns>\n'
    expect(closeContainers(code)).toBe(code)
  })
})

describe('drawings', () => {
  const drawing = (url: string): Block => ({ type: 'drawing', props: { url }, children: [] })

  it('reads an image of an .excalidraw.svg file as a drawing', () => {
    expect(markdownToBlocks('![](attachments/Cat%20Sketch.Excalidraw.SVG)\n')).toEqual([
      drawing('attachments/Cat%20Sketch.Excalidraw.SVG')
    ])
  })

  it('reads a resized drawing from another tool, dropping its width on save', () => {
    const blocks = markdownToBlocks('<img src="attachments/a.excalidraw.svg" width="300">\n')
    expect(blocks).toEqual([drawing('attachments/a.excalidraw.svg')])
    expect(blocksToMarkdown(blocks)).toBe('![](attachments/a.excalidraw.svg)\n')
  })

  it('keeps other SVG images as images', () => {
    expect(markdownToBlocks('![](attachments/logo.svg)\n')[0].type).toBe('image')
  })

  it('writes nothing for a drawing that was never saved', () => {
    expect(blocksToMarkdown([drawing(''), drawing('attachments/a.excalidraw.svg')])).toBe(
      '![](attachments/a.excalidraw.svg)\n'
    )
  })
})

describe('markdown from other tools', () => {
  it('drops code formatting inside link text, which the editor cannot combine with a link', () => {
    const [p] = markdownToBlocks('See [`main.rs`](https://main.rs) here')
    expect(p.content).toEqual([
      { type: 'text', text: 'See ', styles: {} },
      {
        type: 'link',
        href: 'https://main.rs',
        content: [{ type: 'text', text: 'main.rs', styles: {} }]
      },
      { type: 'text', text: ' here', styles: {} }
    ])
  })

  it('reads toggles from files with Windows line endings', () => {
    const [toggle] = markdownToBlocks(
      '<details>\r\n<summary>T</summary>\r\n\r\nInside\r\n\r\n</details>\r\n'
    )
    expect(toggle).toMatchObject({ type: 'toggleListItem', children: [{ type: 'paragraph' }] })
  })

  const verbatim = [
    'See [[Other]] here',
    'See ![badge](a.png) here',
    '[![badge](a.png)](https://x.dev)',
    '[$x$](https://x.dev)',
    'press <kbd>Ctrl</kbd> now',
    'a <!-- note --> b'
  ]
  for (const md of verbatim) {
    it(`keeps ${JSON.stringify(md)} verbatim`, () => {
      expect(markdownToBlocks(md)).toEqual([{ type: 'raw', props: { markdown: md }, children: [] }])
      expect(roundTrip(`${md}\n`)).toBe(`${md}\n`)
    })
  }

  it('keeps unsupported markdown inside a list item verbatim', () => {
    const md = '- item\n\n  See [[A]] and [[B]]\n'
    expect(markdownToBlocks(md)[0].children[0]).toEqual({
      type: 'raw',
      props: { markdown: 'See [[A]] and [[B]]' },
      children: []
    })
    expect(roundTrip(md)).toBe(md)
  })

  it('keeps editor text that merely looks like a wikilink editable', () => {
    const md = blocksToMarkdown([
      {
        type: 'paragraph',
        props: {},
        content: [{ type: 'text', text: '[[x]]', styles: {} }],
        children: []
      }
    ])
    expect(markdownToBlocks(md)[0].type).toBe('paragraph')
  })

  it('writes file blocks whose url has a stray percent sign', () => {
    expect(
      blocksToMarkdown([
        { type: 'file', props: { url: 'https://x.dev/100%', name: '' }, children: [] }
      ])
    ).toBe('[100%](https://x.dev/100% "file")\n')
  })
})

describe('editor documents survive a round trip', () => {
  const editorDoc: Block[] = [
    {
      id: 'a',
      type: 'heading',
      props: { level: 1, isToggleable: false, textColor: 'default', backgroundColor: 'default' },
      content: [{ type: 'text', text: 'Title', styles: {} }],
      children: []
    },
    {
      id: 'b',
      type: 'paragraph',
      props: { textColor: 'default', backgroundColor: 'yellow' },
      content: [
        { type: 'text', text: 'Mixed ', styles: {} },
        { type: 'text', text: 'bold', styles: { bold: true } },
        { type: 'text', text: 'and', styles: { bold: true, italic: true } },
        { type: 'text', text: ' ', styles: {} },
        { type: 'text', text: 'red under', styles: { textColor: 'red', underline: true } },
        {
          type: 'link',
          href: 'https://x.dev',
          content: [{ type: 'text', text: 'link', styles: { strike: true } }]
        }
      ],
      children: [
        {
          id: 'c',
          type: 'bulletListItem',
          props: { textColor: 'default', backgroundColor: 'default' },
          content: [{ type: 'text', text: 'child', styles: {} }],
          children: []
        }
      ]
    },
    {
      id: 'd',
      type: 'callout',
      props: { icon: '💡', textColor: 'default', backgroundColor: 'gray' },
      content: [],
      children: [
        {
          id: 'e',
          type: 'paragraph',
          props: {},
          content: [{ type: 'text', text: 'inside', styles: {} }],
          children: []
        }
      ]
    },
    {
      id: 'f',
      type: 'quote',
      props: { textColor: 'default', backgroundColor: 'default' },
      content: [],
      children: [
        {
          id: 'g',
          type: 'paragraph',
          props: {},
          content: [{ type: 'text', text: 'q child', styles: {} }],
          children: []
        }
      ]
    },
    {
      id: 'h',
      type: 'table',
      props: { textColor: 'default' },
      content: {
        type: 'tableContent',
        columnWidths: [undefined, undefined],
        rows: [
          {
            cells: [
              {
                type: 'tableCell',
                props: {},
                content: [{ type: 'text', text: 'a\nb', styles: {} }]
              },
              { type: 'tableCell', props: {}, content: [] }
            ]
          },
          {
            cells: [
              {
                type: 'tableCell',
                props: {},
                content: [{ type: 'text', text: '|pipe|', styles: {} }]
              },
              { type: 'tableCell', props: {}, content: [] }
            ]
          }
        ]
      },
      children: []
    },
    {
      id: 'i',
      type: 'numberedListItem',
      props: {},
      content: [{ type: 'text', text: 'one', styles: {} }],
      children: []
    },
    {
      id: 'j',
      type: 'numberedListItem',
      props: {},
      content: [{ type: 'text', text: 'two', styles: {} }],
      children: []
    },
    { id: 'k', type: 'checkListItem', props: { checked: true }, content: [], children: [] },
    { id: 'l', type: 'paragraph', props: {}, content: [], children: [] },
    {
      id: 'm',
      type: 'paragraph',
      props: {},
      content: [{ type: 'text', text: 'spaced', styles: { bold: true } }],
      children: []
    },
    {
      id: 'n',
      type: 'paragraph',
      props: {},
      content: [{ type: 'text', text: '# not heading *not em* <b>', styles: {} }],
      children: []
    },
    { id: 'o', type: 'paragraph', props: {}, content: [], children: [] }
  ]

  it('keeps every block, style and color', () => {
    const md = blocksToMarkdown(editorDoc)
    expect(normalizeBlocks(markdownToBlocks(md))).toEqual(normalizeBlocks(editorDoc))
  })
})
