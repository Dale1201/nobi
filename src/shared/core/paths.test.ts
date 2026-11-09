import { describe, expect, it } from 'vitest'
import { relativeHref, resolveHref, sanitizeTitle, encodeHref, isExternalHref } from './paths'
import { insertId, parsePage, serializePage } from './page'

describe('paths', () => {
  it('sanitizes titles for filenames', () => {
    expect(sanitizeTitle('A/B: C?')).toBe('A-B- C-')
    expect(sanitizeTitle('.hidden')).toBe('-hidden')
    expect(sanitizeTitle('   ')).toBe('Untitled')
    expect(sanitizeTitle('a\\b')).toBe('a-b')
    expect(sanitizeTitle('🚀 Launch')).toBe('🚀 Launch')
  })

  it('keeps long titles within filename limits', () => {
    for (const title of ['a'.repeat(199) + '🚀', '漢'.repeat(200)]) {
      const name = sanitizeTitle(title)
      expect(name.isWellFormed()).toBe(true)
      expect(Buffer.byteLength(name, 'utf8')).toBeLessThanOrEqual(200)
    }
  })

  it('resolves and relativizes hrefs', () => {
    expect(resolveHref('Projects/Plan.md', '../attachments/a%20b.png')).toBe('attachments/a b.png')
    expect(resolveHref('Plan.md', 'Plan/Child.md')).toBe('Plan/Child.md')
    expect(relativeHref('Projects/Plan.md', 'attachments/a b.png')).toBe('../attachments/a%20b.png')
    expect(relativeHref('Projects.md', 'Projects/Web.md')).toBe('Projects/Web.md')
    expect(relativeHref('A/B/C.md', 'A/D.md')).toBe('../D.md')
    expect(encodeHref('My Notes/🚀.md')).toBe('My%20Notes/%F0%9F%9A%80.md')
  })

  it('detects external hrefs', () => {
    expect(isExternalHref('https://x.dev')).toBe(true)
    expect(isExternalHref('mailto:a@b.c')).toBe(true)
    expect(isExternalHref('nobi://page/1')).toBe(true)
    expect(isExternalHref('#top')).toBe(true)
    expect(isExternalHref('Other.md')).toBe(false)
  })
})

describe('page files', () => {
  it('round-trips frontmatter and keeps unknown keys', () => {
    const text = '---\nid: abc\ntitle: A/B\nicon: 🚀\ntags:\n  - x\n---\n\nHello\n'
    const page = parsePage(text)
    expect(page.meta).toEqual({ id: 'abc', title: 'A/B', icon: '🚀', extra: { tags: ['x'] } })
    expect(serializePage(page.meta, page.blocks)).toBe(text)
  })

  it('keeps invalid frontmatter as a raw block, flagged, byte for byte', () => {
    const page = parsePage('---\nid: [oops\n---\nBody\n')
    expect(page.meta).toEqual({ extra: {} })
    expect(page.frontmatterError).toBe(true)
    expect(page.blocks[0]).toEqual({
      type: 'raw',
      props: { markdown: '---\nid: [oops\n---' },
      children: []
    })
    // Below the id header the app adds when it first sees the file.
    const withId = '---\nid: abc\n---\n\n---\ntitle: [oops\n---\n\nBody\n'
    const again = parsePage(withId)
    expect(again.meta.id).toBe('abc')
    expect(again.frontmatterError).toBe(true)
    expect(serializePage(again.meta, again.blocks)).toBe(withId)
    expect(parsePage('---\nid: a\n---\n\nBody\n').frontmatterError).toBeUndefined()
  })

  it('reads files saved with Windows line endings', () => {
    const page = parsePage('---\r\nid: a\r\n---\r\n\r\nHi\r\n')
    expect(page.meta.id).toBe('a')
    expect(page.blocks).toEqual([
      {
        type: 'paragraph',
        props: {},
        content: [{ type: 'text', text: 'Hi', styles: {} }],
        children: []
      }
    ])
  })

  it('ignores a byte-order mark before the frontmatter', () => {
    expect(parsePage('\uFEFF---\nid: abc\n---\n\nHello\n').meta.id).toBe('abc')
  })

  it('keeps frontmatter values that other tools write with different types', () => {
    const page = parsePage('---\nid: 42\ntitle: 2024\ncoverPosition: "30"\nfullWidth: maybe\n---\n')
    expect(page.meta).toEqual({
      id: '42',
      title: '2024',
      coverPosition: 30,
      extra: { fullWidth: 'maybe' }
    })
    expect(serializePage(page.meta, page.blocks)).toContain('fullWidth: maybe')
  })

  it('adds an id without changing anything else', () => {
    expect(insertId('', 'x')).toBe('---\nid: x\n---\n')
    expect(insertId('Body *a*\n', 'x')).toBe('---\nid: x\n---\n\nBody *a*\n')
    expect(insertId('---\n# c\ntags: [a]\n---\nBody\n', 'x')).toBe(
      '---\n# c\ntags: [a]\nid: x\n---\nBody\n'
    )
    expect(insertId('---\nid: [broken\n---\nBody\n', 'x')).toBe(
      '---\nid: x\n---\n\n---\nid: [broken\n---\nBody\n'
    )
    expect(insertId('\uFEFFHi\n', 'x')).toBe('\uFEFF---\nid: x\n---\n\nHi\n')
  })

  it('ignores an id that is not safe as a folder name, keeping its text', () => {
    const page = parsePage('---\nid: ../..\n---\n\nBody\n')
    expect(page.meta.id).toBeUndefined()
    expect(page.meta.extra).toEqual({ id: '../..' })
    expect(insertId('---\nid: ../..\n---\n\nBody\n', 'x')).toBe('---\nid: x\n---\n\nBody\n')
  })

  it('handles files without frontmatter', () => {
    expect(parsePage('Just text\n').meta).toEqual({ extra: {} })
    expect(serializePage({ extra: {} }, [])).toBe('')
  })
})
