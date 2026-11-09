import type { Element, ElementContent } from 'hast'
import type { Inline, StyledText, Styles } from '../core/blocks'
import { normalizeInline } from '../core/normalize'
import { colorFromClasses, notionColor } from './colors'
import { attr, classes, hasClass, isElement, textOf } from './hast'
import type { MapContext } from './types'

/** Rich text in Notion's export HTML, as Nobi inline content. */
export function mapInline(nodes: ElementContent[], ctx: MapContext): Inline[] {
  const out: Inline[] = []
  walk(nodes, {}, out, ctx)
  return normalizeInline(out)
}

function walk(nodes: ElementContent[], styles: Styles, out: Inline[], ctx: MapContext): void {
  for (const node of nodes) {
    if (node.type === 'text') pushText(out, node.value, styles)
    else if (node.type === 'element') element(node, styles, out, ctx)
  }
}

function pushText(out: Inline[], text: string, styles: Styles): void {
  if (text !== '') out.push({ type: 'text', text, styles: { ...styles } })
}

function element(el: Element, styles: Styles, out: Inline[], ctx: MapContext): void {
  const inner = (extra: Styles): void => walk(el.children, { ...styles, ...extra }, out, ctx)
  switch (el.tagName) {
    case 'br':
      return pushText(out, '\n', styles)
    case 'strong':
    case 'b':
      return inner({ bold: true })
    case 'em':
    case 'i':
      return inner({ italic: true })
    case 'del':
    case 's':
      return inner({ strike: true })
    case 'code':
      return inner({ code: true })
    case 'mark': {
      const color = notionColor(attr(el, 'data-notion-highlight'))
      return inner(Object.keys(color).length ? color : colorFromClasses(classes(el), 'highlight-'))
    }
    case 'a':
      return link(el, styles, out, ctx)
    case 'img': {
      // Custom emoji and inline icons keep their alt text; an image without it is reported.
      const alt = attr(el, 'alt')
      if (alt) return pushText(out, alt, styles)
      ctx.issue('skipped', 'Inline image')
      return
    }
    case 'span': {
      const equation = attr(el, 'data-notion-inline-equation')
      if (equation !== undefined || hasClass(el, 'notion-text-equation-token')) {
        const latex = equation ?? textOf(el)
        out.push({ type: 'inlineMath', props: { latex } })
        return
      }
      if (hasClass(el, 'icon')) return
      const underline = /border-bottom:\s*0\.05em solid/.test(attr(el, 'style') ?? '')
      if (hasClass(el, 'selected-value')) {
        return inner(colorAsBackground(colorFromClasses(classes(el), 'select-value-color-')))
      }
      return inner(underline ? { underline: true } : {})
    }
    case 'input':
      if (attr(el, 'type') === 'checkbox') pushText(out, attr(el, 'checked') ? '☑' : '☐', styles)
      return
    default:
      return inner({})
  }
}

/** Select pills are colored backgrounds in Notion, whatever the option's color is called. */
function colorAsBackground(color: { textColor?: string; backgroundColor?: string }): Styles {
  const name = color.textColor ?? color.backgroundColor
  return name ? { backgroundColor: name } : {}
}

function link(el: Element, styles: Styles, out: Inline[], ctx: MapContext): void {
  const href = attr(el, 'href') ?? ''
  const content: Inline[] = []
  walk(el.children, styles, content, ctx)
  const text = content.filter((c): c is StyledText => c.type === 'text')
  if (href === '' || href.startsWith('#')) {
    out.push(...text)
    return
  }
  const target = ctx.link(href, attr(el, 'data-notion-page-id'))
  const label = text.length ? text : [{ type: 'text' as const, text: href, styles: { ...styles } }]
  out.push({ type: 'link', href: target, content: label })
}

export function isInlineNode(node: ElementContent): boolean {
  if (node.type === 'text') return true
  if (!isElement(node)) return false
  return INLINE_TAGS.has(node.tagName)
}

const INLINE_TAGS = new Set([
  'a',
  'b',
  'br',
  'code',
  'del',
  'em',
  'i',
  'img',
  'input',
  'mark',
  's',
  'span',
  'strong',
  'time',
  'sub',
  'sup',
  'u'
])
