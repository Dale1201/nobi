import { describe, expect, it } from 'vitest'
import { isValidLink, normalizeLinkInput } from './links'

describe('normalizeLinkInput', () => {
  const cases: [string, string][] = [
    ['', ''],
    ['  example.com  ', 'https://example.com'],
    ['sub.example.co.uk/path?q=1', 'https://sub.example.co.uk/path?q=1'],
    ['https://example.com', 'https://example.com'],
    ['nobi://page/123', 'nobi://page/123'],
    ['/attachments/a%20b.png', '/attachments/a%20b.png'],
    ['../Other.md', '../Other.md'],
    ['#heading', '#heading'],
    ['a@b.co', 'mailto:a@b.co'],
    ['notes', 'notes']
  ]
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
      expect(normalizeLinkInput(input)).toBe(expected)
    })
  }
})

describe('isValidLink', () => {
  it('allows app, local and web links', () => {
    for (const ok of ['nobi://page/1', '/a.png', '../b.md', '#x', 'https://a.b', 'mailto:a@b.c']) {
      expect(isValidLink(ok)).toBe(true)
    }
  })
  it('blocks script and file schemes, even when obfuscated', () => {
    for (const bad of [
      'javascript:alert(1)',
      ' java\tscript:alert(1)',
      'data:text/html,x',
      'file:///etc/passwd'
    ]) {
      expect(isValidLink(bad)).toBe(false)
    }
  })
})
