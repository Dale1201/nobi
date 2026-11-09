const ALLOWED_SCHEME = /^(?:https?|mailto|tel|nobi):/i
const ANY_SCHEME = /^[a-z][a-z0-9+.-]*:/i
const LOCAL_PREFIX = /^(?:\/|\.\/|\.\.\/|#)/
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const BARE_DOMAIN = /^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/

// Replaces BlockNote's default (not exported from 0.56), which rejects nobi://.
// Scheme-less hrefs (/attachments/..., ../Other.md, #x) are always allowed.
export function isValidLink(href: string): boolean {
  // Browsers ignore whitespace and control characters inside schemes ("java\tscript:").
  const cleaned = [...href]
    .filter((c) => c.trim() !== '' && c.charCodeAt(0) > 0x1f && c.charCodeAt(0) !== 0x7f)
    .join('')
  return ALLOWED_SCHEME.test(cleaned) || !ANY_SCHEME.test(cleaned)
}

// Replaces BlockNote's link form normalization, which prefixes https:// to anything
// outside a fixed protocol list (turning /a.png into https:///a.png).
export function normalizeLinkInput(input: string): string {
  const value = input.trim()
  if (value === '') return ''
  if (LOCAL_PREFIX.test(value) || ANY_SCHEME.test(value)) return value
  if (EMAIL.test(value)) return `mailto:${value}`
  if (BARE_DOMAIN.test(value)) return `https://${value}`
  return value
}

export function linkHrefFromEvent(event: MouseEvent): string | null {
  const target = event.target instanceof Element ? event.target : null
  return target?.closest('a[href]')?.getAttribute('href') ?? null
}
