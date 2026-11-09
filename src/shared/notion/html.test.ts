import { fromHtml } from 'hast-util-from-html'
import { describe, expect, it } from 'vitest'
import { blocksToMarkdown } from '../core/serialize'
import { notionColor } from './colors'
import { mapNotionFragment, mapNotionPage } from './html'
import type { MapContext } from './types'

function context(): MapContext & { issues: string[] } {
  const issues: string[] = []
  return {
    issues,
    link: (href, pageId) => (pageId ? `nobi://page/${pageId}` : href),
    file: (src) => `/attachments/${src.split('/').pop()}`,
    issue: (kind, detail) => issues.push(`${kind}: ${detail}`)
  }
}

function md(html: string, ctx = context()): string {
  return blocksToMarkdown(mapNotionFragment(fromHtml(html, { fragment: true }), ctx))
}

/** Table Markdown without its column padding. */
function unpadded(markdown: string): string {
  return markdown.replace(/ {2,}/g, ' ').replace(/-{3,}/g, '---')
}

describe('notionColor', () => {
  it('reads text and background colors, and calls teal green', () => {
    expect(notionColor('red')).toEqual({ textColor: 'red' })
    expect(notionColor('yellow_background')).toEqual({ backgroundColor: 'yellow' })
    expect(notionColor('teal')).toEqual({ textColor: 'green' })
    expect(notionColor('teal_background')).toEqual({ backgroundColor: 'green' })
    expect(notionColor('default')).toEqual({})
    expect(notionColor(undefined)).toEqual({})
  })
})

describe('mapNotionPage', () => {
  it('reads the title, emoji icon and cover from the header', () => {
    const page = mapNotionPage(
      fromHtml(
        '<article><header><img class="page-cover-image" src="cover.png">' +
          '<div class="page-header-icon"><span class="icon" data-emoji="🧪"></span></div>' +
          '<h1 class="page-title">Plans: 2026</h1></header><div class="page-body"><p>Hi</p></div></article>'
      ),
      context()
    )
    expect(page.title).toBe('Plans: 2026')
    expect(page.icon).toEqual({ emoji: '🧪' })
    expect(page.cover).toBe('/attachments/cover.png')
    expect(blocksToMarkdown(page.blocks)).toBe('Hi\n')
  })

  it('reads an image icon and a database row’s properties', () => {
    const page = mapNotionPage(
      fromHtml(
        '<header><div class="page-header-icon"><img class="icon" src="Row/icon.png"></div>' +
          '<h1 class="page-title">Row</h1><table class="properties"><tbody>' +
          '<tr class="property-row"><th><span class="icon property-icon"><img src="x.svg"></span>Status</th>' +
          '<td><span class="selected-value select-value-color-green">Done</span></td></tr>' +
          '</tbody></table></header><div class="page-body"></div>'
      ),
      context()
    )
    expect(page.icon).toEqual({ src: '/attachments/icon.png' })
    expect(page.properties).toEqual([
      {
        name: 'Status',
        value: [{ type: 'text', text: 'Done', styles: { backgroundColor: 'green' } }]
      }
    ])
  })
})

describe('mapNotionFragment', () => {
  it('drops code formatting inside link text, which the editor cannot combine with a link', () => {
    expect(md('<p><a href="https://main.rs"><code>main.rs</code></a></p>')).toBe(
      '[main.rs](https://main.rs)\n'
    )
  })

  it('keeps inline styles, colors and inline math', () => {
    expect(
      md(
        '<p><strong>b</strong> <em>i</em> <span style="border-bottom:0.05em solid">u</span> ' +
          '<del>s</del> <code>c</code> <mark class="highlight-red">red</mark> ' +
          '<mark data-notion-highlight="teal_background">green</mark> ' +
          '<span data-notion-inline-equation="x^2" class="notion-text-equation-token"><span>x2</span></span></p>'
      )
    ).toBe(
      '**b** *i* <u>u</u> ~~s~~ `c` <span data-color="red">red</span> <span data-bg="green">green</span> $x^2$\n'
    )
  })

  it('maps block colors, an empty paragraph and every heading level', () => {
    expect(
      md(
        '<p class="block-color-blue">Blue</p><p>\n</p><h1>One</h1><h4>Four</h4>' +
          '<h3 class="block-color-purple_background">Bg</h3>'
      )
    ).toBe('Blue<!-- color=blue -->\n\n&nbsp;\n\n# One\n\n#### Four\n\n### Bg<!-- bg=purple -->\n')
  })

  it('joins numbered items Notion writes as separate lists', () => {
    expect(
      md(
        '<ol class="numbered-list" start="1"><li>One</li></ol>' +
          '<ol class="numbered-list" start="2"><li>Two<ol class="numbered-list" start="1"><li>Inner</li></ol></li></ol>' +
          '<ol class="numbered-list" start="3"><li>Three</li></ol>'
      )
    ).toBe('1. One\n2. Two\n   1. Inner\n3. Three\n')
  })

  it('keeps a list that starts at another number', () => {
    expect(md('<p>Intro</p><ol class="numbered-list" start="4"><li>Four</li></ol>')).toBe(
      'Intro\n\n4. Four\n'
    )
  })

  it('maps to-dos with their nested items', () => {
    expect(
      md(
        '<ul class="to-do-list"><li><input type="checkbox" class="checkbox checkbox-on" checked> ' +
          '<span class="to-do-children-checked">Done</span><div class="indented">' +
          '<ul class="to-do-list"><li><input type="checkbox" class="checkbox checkbox-off"> ' +
          '<span class="to-do-children-unchecked">Open</span><div class="indented"></div></li></ul>' +
          '</div></li></ul>'
      )
    ).toBe('- [x] Done\n  - [ ] Open\n')
  })

  it('maps toggles and toggle headings', () => {
    expect(
      md(
        '<details class="toggle"><summary>Title</summary><div class="indented"><p>Inside</p></div></details>' +
          '<details><summary><h2>Big</h2></summary><div class="indented"><p>Under</p></div></details>'
      )
    ).toBe(
      '<details>\n<summary>Title</summary>\n\nInside\n\n</details>\n\n' +
        '<details data-heading="2">\n<summary>Big</summary>\n\nUnder\n\n</details>\n'
    )
  })

  it('maps quotes with children and callouts with their icon and color', () => {
    expect(
      md(
        '<blockquote class="block-color-teal_background">Quote<p>Child</p></blockquote>' +
          '<aside class="callout" data-notion-callout-icon="🚧" data-notion-callout-background="orange_background">' +
          '<div><span class="icon" data-emoji="🚧"></span></div><div style="width:100%"><p>Careful</p>' +
          '<ul class="bulleted-list"><li>Item</li></ul></div></aside>'
      )
    ).toBe(
      '> Quote<!-- bg=green -->\n>\n> Child\n\n> [!callout:orange_bg] 🚧\n> Careful\n>\n> - Item\n'
    )
  })

  it('maps code, equations, dividers and the table of contents', () => {
    expect(
      md(
        '<pre class="code" data-notion-code-syntax="Python"><code class="language-python">print(1)</code></pre>' +
          '<figure class="equation" data-notion-equation="a+b"><span class="katex">a+b</span></figure>' +
          '<hr><nav class="table_of_contents"><a href="#x">X</a></nav>'
      )
    ).toBe('```python\nprint(1)\n```\n\n$$\na+b\n$$\n\n---\n\n<nav data-toc></nav>\n')
  })

  it('maps images, files, bookmarks and embeds', () => {
    expect(
      md(
        '<figure class="image"><a href="Page/a%20b.png"><img src="Page/a%20b.png"></a><figcaption>Cap</figcaption></figure>' +
          '<figure><div class="source"><a href="Page/r.pdf" data-notion-file="Page/r.pdf" data-notion-file-alias="r.pdf">r.pdf</a></div></figure>' +
          '<figure><a href="https://w.org" class="bookmark source"><div class="bookmark-title">W</div></a></figure>' +
          '<figure><div class="source"><a href="https://youtu.be/x">https://youtu.be/x</a></div></figure>'
      )
    ).toBe(
      '![Cap](/attachments/a%20b.png)\n\n[r.pdf](/attachments/r.pdf "file")\n\n[W](https://w.org)\n\n<https://youtu.be/x>\n'
    )
  })

  it('maps columns with their widths', () => {
    expect(
      md(
        '<div class="column-list"><div class="column" data-notion-column-ratio="0.25"><p>A</p></div>' +
          '<div class="column" style="width:75%"><p>B</p></div></div>'
      )
    ).toBe(
      '<div data-columns>\n\n<div data-column data-width="0.5">\n\nA\n\n</div>\n\n' +
        '<div data-column data-width="1.5">\n\nB\n\n</div>\n\n</div>\n'
    )
  })

  it('turns sub-page links into page blocks, or plain links when the page is not imported', () => {
    const ctx = context()
    ctx.link = (href, pageId) => (pageId === 'a' ? 'nobi://page/a' : href)
    expect(
      md(
        '<figure class="link-to-page"><a href="A.html" data-notion-page-id="a"><span class="icon"></span>A</a></figure>' +
          '<figure class="link-to-page"><a href="https://www.notion.so/b" data-notion-page-id="b">B</a></figure>',
        ctx
      )
    ).toBe('[a](nobi://page/a "page")\n\n[B](https://www.notion.so/b)\n')
  })

  it('keeps the content of synced blocks and color wrappers', () => {
    expect(
      md(
        '<div><p>Synced</p></div><div data-notion-highlight="red"><ul class="block-color-red bulleted-list"><li>R</li></ul></div>'
      )
    ).toBe('Synced\n\n- R<!-- color=red -->\n')
  })

  it('maps a database view, keeping pill colors and checkboxes', () => {
    expect(
      unpadded(
        md(
          '<div class="collection-content-wrapper"><table class="collection-content"><thead><tr>' +
            '<th><span class="icon property-icon"><img src="i.svg"></span>Name</th><th>Tags</th><th>Done</th></tr></thead>' +
            '<tbody><tr><td class="cell-title"><a href="Db/Row.html" data-notion-page-id="r">Row</a></td>' +
            '<td><span class="selected-value select-value-color-brown">a</span><span class="selected-value select-value-color-purple">b</span></td>' +
            '<td><input type="checkbox" class="checkbox checkbox-on" checked></td></tr></tbody></table></div>'
        )
      )
    ).toBe(
      '| Name | Tags | Done |\n| --- | --- | --- |\n' +
        '| [Row](nobi://page/r) | <span data-bg="brown">a</span> <span data-bg="purple">b</span> | ☑ |\n'
    )
  })

  it('maps an inline database with its title', () => {
    expect(
      unpadded(
        md(
          '<div class="collection-content"><h4 class="collection-title">Tasks</h4>' +
            '<table class="collection-content"><thead><tr><th>Name</th></tr></thead>' +
            '<tbody><tr><td class="cell-title"><a href="Tasks/Write.html" data-notion-page-id="w">Write</a></td></tr>' +
            '</tbody></table></div>'
        )
      )
    ).toBe('### Tasks\n\n| Name |\n| --- |\n| [Write](nobi://page/w) |\n')
  })

  it('reports table formatting Markdown cannot keep', () => {
    const ctx = context()
    md(
      '<table class="simple-table"><thead><tr><th>A</th><th>B</th></tr></thead><tbody>' +
        '<tr><th>C</th><td class="block-color-red_background">D</td></tr></tbody></table>',
      ctx
    )
    expect(ctx.issues).toEqual([
      'table: Header column (kept as a normal column)',
      'table: Table cell colors'
    ])
  })

  it('keeps the text of blocks it does not know, and reports them', () => {
    const ctx = context()
    expect(
      md('<section class="mystery">Some text</section><nav class="breadcrumb"></nav>', ctx)
    ).toBe('Some text\n')
    expect(ctx.issues).toEqual(['unknown: section.mystery', 'skipped: nav.breadcrumb'])
  })

  it('skips a video or audio with no source, and reports it', () => {
    const ctx = context()
    expect(md('<video></video>', ctx)).toBe('')
    expect(ctx.issues).toEqual(['skipped: video'])
  })

  it('takes a video source from its source child', () => {
    expect(md('<video><source src="Page/v.mp4"></video>')).toBe(
      '<video src="/attachments/v.mp4" controls></video>\n'
    )
  })

  it('keeps a bare image and an image-only paragraph as image blocks', () => {
    expect(md('<img src="Page/a.png">')).toBe('![](/attachments/a.png)\n')
    expect(md('<p><img src="Page/a.png" alt="Pic"></p>')).toBe('![Pic](/attachments/a.png)\n')
  })

  it('keeps an inline image alt text, and reports an inline image without one', () => {
    const ctx = context()
    expect(md('<p>See <img src="x.png" alt="icon"> now</p>', ctx)).toBe('See icon now\n')
    expect(ctx.issues).toEqual([])
    expect(md('<p>Hi <img src="x.png"> there</p>', ctx)).toBe('Hi  there\n')
    expect(ctx.issues).toEqual(['skipped: Inline image'])
  })

  it('keeps the caption of a bookmark and of a video', () => {
    expect(
      md(
        '<figure><a href="https://w.org" class="bookmark source"><div class="bookmark-title">W</div></a>' +
          '<figcaption>Cap</figcaption></figure>'
      )
    ).toBe('[W](https://w.org)\n\nCap\n')
    expect(
      md('<figure><video src="Page/v.mp4"></video><figcaption>Cap</figcaption></figure>')
    ).toBe('<video src="/attachments/v.mp4" data-caption="Cap" controls></video>\n')
  })

  it('keeps a figure image source as written, even when it is not valid URI text', () => {
    expect(md('<figure class="image" data-notion-image="Page/a%ZZ.png"></figure>')).toBe(
      '![](/attachments/a%ZZ.png)\n'
    )
  })

  it('ignores a list start that is not a whole number', () => {
    const blocks = mapNotionFragment(
      fromHtml('<ol class="numbered-list" start="x"><li>A</li></ol>', { fragment: true }),
      context()
    )
    expect(blocks[0].props).toEqual({})
    expect(md('<ol class="numbered-list" start="x"><li>A</li></ol>')).toBe('1. A\n')
  })
})
