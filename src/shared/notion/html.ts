import type { Element, ElementContent, Root } from 'hast'
import type { Block, BlockColors, Inline, TableContent } from '../core/blocks'
import { DEFAULT_CALLOUT_ICON } from '../core/blocks'
import { isExternalHref } from '../core/paths'
import { pageIdFromHref } from '../core/links'
import { colorFromClasses, notionColor } from './colors'
import { attr, classes, elements, find, hasClass, isElement, textOf } from './hast'
import { isInlineNode, mapInline } from './inline'
import type { MapContext, MappedPage, NotionIcon } from './types'

/** One page of Notion's HTML export: title, icon, cover, database properties and blocks. */
export function mapNotionPage(root: Root, ctx: MapContext): MappedPage {
  const header = find(root, (el) => el.tagName === 'header')
  const body = find(root, (el) => hasClass(el, 'page-body'))
  const titleEl = header && find(header, (el) => hasClass(el, 'page-title'))
  const properties = header ? mapProperties(header, ctx) : []
  return {
    title: titleEl ? textOf(titleEl).trim() : '',
    icon: header ? pageIcon(header, ctx) : undefined,
    cover: header ? pageCover(header, ctx) : undefined,
    properties,
    blocks: body ? mapBlocks(body.children, ctx) : []
  }
}

/** Blocks of an HTML fragment, such as Notion's `text/html` clipboard copy. */
export function mapNotionFragment(root: Root, ctx: MapContext): Block[] {
  const body = find(root, (el) => el.tagName === 'body') ?? root
  return mapBlocks(body.children as ElementContent[], ctx)
}

function pageIcon(header: Element, ctx: MapContext): NotionIcon | undefined {
  const box = find(header, (el) => hasClass(el, 'page-header-icon'))
  if (!box) return undefined
  const emoji = find(box, (el) => attr(el, 'data-emoji') !== undefined)
  if (emoji) return { emoji: attr(emoji, 'data-emoji')! }
  const img = find(box, (el) => el.tagName === 'img')
  const src = img && attr(img, 'src')
  if (src) return { src: ctx.file(src) }
  const text = textOf(box).trim()
  return text ? { emoji: text } : undefined
}

function pageCover(header: Element, ctx: MapContext): string | undefined {
  const img = find(header, (el) => hasClass(el, 'page-cover-image'))
  const src = img && attr(img, 'src')
  return src ? ctx.file(src) : undefined
}

function mapProperties(header: Element, ctx: MapContext): MappedPage['properties'] {
  const table = find(header, (el) => el.tagName === 'table' && hasClass(el, 'properties'))
  if (!table) return []
  return findRows(table).map((row) => {
    const [name, value] = elements(row)
    return {
      name: name ? textOf(name).trim() : '',
      value: value ? cellInline(value, ctx) : []
    }
  })
}

// ---------- blocks ----------

export function mapBlocks(nodes: ElementContent[], ctx: MapContext): Block[] {
  const out: Block[] = []
  let loose: ElementContent[] = []
  const flush = (): void => {
    const content = mapInline(loose, ctx)
    loose = []
    if (content.some((c) => c.type !== 'text' || c.text.trim() !== '')) {
      out.push(paragraph(content))
    }
  }
  for (const node of nodes) {
    if (isInlineNode(node) && !isElement(node, 'img')) {
      loose.push(node)
      continue
    }
    flush()
    if (isElement(node)) out.push(...mapElement(node, ctx))
  }
  flush()
  return joinNumberedLists(out)
}

/** Notion writes every numbered item as its own `<ol start>`; only a list's first item keeps it. */
function joinNumberedLists(blocks: Block[]): Block[] {
  return blocks.map((block, i) => {
    if (block.type !== 'numberedListItem' || blocks[i - 1]?.type !== 'numberedListItem')
      return block
    const props = { ...block.props }
    delete props.start
    return { ...block, props }
  })
}

function mapElement(el: Element, ctx: MapContext): Block[] {
  const colors = blockColors(el)
  switch (el.tagName) {
    case 'p': {
      const images = paragraphImages(el)
      if (images) return images.map((img) => imageOf(img, ctx))
      return [paragraph(trimEmpty(mapInline(el.children, ctx)), colors)]
    }
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return [heading(Number(el.tagName[1]), mapInline(el.children, ctx), colors)]
    case 'ul':
    case 'ol':
      return mapList(el, ctx)
    case 'details':
      return [mapToggle(el, ctx)]
    case 'blockquote':
      return [mapQuote(el, ctx)]
    case 'aside':
      return [mapCallout(el, ctx)]
    case 'hr':
      return [{ type: 'divider', props: {}, children: [] }]
    case 'pre':
      return [mapCode(el)]
    case 'figure':
      return mapFigure(el, ctx)
    case 'table':
      return [mapTable(el, ctx)]
    case 'nav':
      if (hasClass(el, 'table_of_contents') || attr(el, 'data-notion-toc') !== undefined) {
        return [{ type: 'toc', props: {}, children: [] }]
      }
      return skipped(el, ctx)
    case 'div':
      return mapDiv(el, ctx)
    case 'img':
      return [imageOf(el, ctx)]
    case 'video':
    case 'audio':
      return mediaBlock(el, ctx, '')
    case 'script':
    case 'style':
    case 'link':
    case 'meta':
      return []
    default:
      return unknown(el, ctx)
  }
}

function blockColors(el: Element): BlockColors {
  const color = notionColor(attr(el, 'data-notion-highlight'))
  return Object.keys(color).length ? color : colorFromClasses(classes(el), 'block-color-')
}

function paragraph(content: Inline[], colors: BlockColors = {}): Block {
  return { type: 'paragraph', props: { ...colors }, content, children: [] }
}

function heading(level: number, content: Inline[], colors: BlockColors = {}): Block {
  return { type: 'heading', props: { level, ...colors }, content, children: [] }
}

/** Notion writes an empty paragraph as a newline. */
function trimEmpty(content: Inline[]): Inline[] {
  return content.length === 1 && content[0].type === 'text' && content[0].text.trim() === ''
    ? []
    : content
}

function mapList(el: Element, ctx: MapContext): Block[] {
  const listColors = blockColors(el)
  const ordered = el.tagName === 'ol'
  const todo = hasClass(el, 'to-do-list')
  const start = Number(attr(el, 'start') ?? '1')
  return elements(el)
    .filter((li) => li.tagName === 'li')
    .map((li, i): Block => {
      const { content, children } = splitItem(li, ctx)
      const colors = { ...listColors, ...blockColors(li) }
      if (todo) {
        const box = find(li, (e) => e.tagName === 'input')
        const checked = box
          ? hasClass(box, 'checkbox-on') || attr(box, 'checked') !== undefined
          : false
        return { type: 'checkListItem', props: { checked, ...colors }, content, children }
      }
      if (ordered) {
        const props =
          i === 0 && Number.isInteger(start) && start !== 1 ? { start, ...colors } : { ...colors }
        return { type: 'numberedListItem', props, content, children }
      }
      return { type: 'bulletListItem', props: colors, content, children }
    })
}

/** A list item's own text, then its nested blocks (nested lists or an `indented` div). */
function splitItem(li: Element, ctx: MapContext): { content: Inline[]; children: Block[] } {
  const own: ElementContent[] = []
  const nested: ElementContent[] = []
  for (const node of li.children) {
    if (isElement(node, 'input')) continue
    if (isElement(node) && hasClass(node, 'indented')) nested.push(...node.children)
    else if (nested.length === 0 && isInlineNode(node)) own.push(node)
    else nested.push(node)
  }
  return { content: trimEdges(mapInline(own, ctx)), children: mapBlocks(nested, ctx) }
}

function trimEdges(content: Inline[]): Inline[] {
  const first = content[0]
  if (first?.type === 'text') first.text = first.text.replace(/^\s+/, '')
  const last = content[content.length - 1]
  if (last?.type === 'text') last.text = last.text.replace(/\s+$/, '')
  return content.filter((c) => c.type !== 'text' || c.text !== '')
}

function mapToggle(el: Element, ctx: MapContext): Block {
  const summary = elements(el).find((c) => c.tagName === 'summary')
  const body = elements(el).find((c) => hasClass(c, 'indented'))
  const children = body ? mapBlocks(body.children, ctx) : []
  const colors = blockColors(el)
  const head = summary && elements(summary).find((c) => /^h[1-6]$/.test(c.tagName))
  if (head) {
    const block = heading(Number(head.tagName[1]), mapInline(head.children, ctx), colors)
    return { ...block, props: { ...block.props, isToggleable: true }, children } as Block
  }
  const content = summary ? mapInline(summary.children, ctx) : []
  return { type: 'toggleListItem', props: colors, content, children }
}

function mapQuote(el: Element, ctx: MapContext): Block {
  const own: ElementContent[] = []
  let rest: ElementContent[] = []
  for (const node of el.children) {
    if (rest.length === 0 && isInlineNode(node)) own.push(node)
    else rest.push(node)
  }
  let content = trimEdges(mapInline(own, ctx))
  // Exports from the clipboard put the quote's text in its first paragraph.
  if (content.length === 0 && isElement(rest[0], 'p')) {
    content = mapInline((rest[0] as Element).children, ctx)
    rest = rest.slice(1)
  }
  return { type: 'quote', props: blockColors(el), content, children: mapBlocks(rest, ctx) }
}

function mapCallout(el: Element, ctx: MapContext): Block {
  const iconBox = elements(el)[0]
  const emoji =
    attr(el, 'data-notion-callout-icon') ??
    (iconBox &&
      attr(find(iconBox, (e) => attr(e, 'data-emoji') !== undefined) ?? iconBox, 'data-emoji'))
  const iconImage = !emoji && iconBox ? find(iconBox, (e) => e.tagName === 'img') : undefined
  if (iconImage) ctx.issue('skipped', 'Callout image icon (shown as 💡)')
  const body = elements(el).find((c) => attr(c, 'style')?.includes('width:100%')) ?? elements(el)[1]
  const blocks = body ? mapBlocks(body.children, ctx) : []
  const background = attr(el, 'data-notion-callout-background')
  const colors = background ? notionColor(background) : blockColors(el)
  const first = blocks[0]
  const lead = first?.type === 'paragraph' && Object.keys(first.props).length === 0 ? first : null
  return {
    type: 'callout',
    props: { icon: emoji ?? DEFAULT_CALLOUT_ICON, ...calloutColors(colors) },
    content: lead ? lead.content : [],
    children: [...(lead ? lead.children : []), ...blocks.slice(lead ? 1 : 0)]
  }
}

/** A callout always has a background in Nobi; Notion's plain callouts are gray. */
function calloutColors(colors: BlockColors): BlockColors {
  return colors.backgroundColor || colors.textColor ? colors : { backgroundColor: 'gray' }
}

function mapCode(el: Element): Block {
  const code = find(el, (e) => e.tagName === 'code') ?? el
  const fromClass = classes(code)
    .find((c) => c.startsWith('language-'))
    ?.slice('language-'.length)
  const language = attr(el, 'data-notion-code-syntax') ?? fromClass ?? 'text'
  const text = textOf(code)
  return {
    type: 'codeBlock',
    props: { language: language.toLowerCase() },
    content: text ? [{ type: 'text', text, styles: {} }] : [],
    children: []
  }
}

function mapFigure(el: Element, ctx: MapContext): Block[] {
  const caption = elements(el).find((c) => c.tagName === 'figcaption')
  const captionText = caption ? textOf(caption).trim() : ''
  if (hasClass(el, 'equation')) {
    const latex =
      attr(el, 'data-notion-equation') ??
      textOf(find(el, (e) => e.tagName === 'annotation') ?? el).trim()
    return [{ type: 'math', props: { latex }, children: [] }]
  }
  if (hasClass(el, 'image') || attr(el, 'data-notion-image') !== undefined) {
    const img = find(el, (e) => e.tagName === 'img')
    const src = (img && attr(img, 'src')) ?? attr(el, 'data-notion-image') ?? ''
    return [image(ctx.file(src), captionText)]
  }
  if (hasClass(el, 'link-to-page')) return [pageLinkBlock(el, ctx)]
  if (hasClass(el, 'callout')) return [mapCallout(el, ctx)]
  const bookmark = find(el, (e) => e.tagName === 'a' && hasClass(e, 'bookmark'))
  if (bookmark) {
    const href = attr(bookmark, 'href') ?? ''
    const titleEl = find(bookmark, (e) => hasClass(e, 'bookmark-title'))
    const title = (titleEl && textOf(titleEl).trim()) || href
    const blocks = [linkParagraph(href, title, ctx)]
    if (captionText) blocks.push(paragraph([{ type: 'text', text: captionText, styles: {} }]))
    return blocks
  }
  const media = find(el, (e) => e.tagName === 'video' || e.tagName === 'audio')
  if (media) return mediaBlock(media, ctx, captionText)
  const source = find(el, (e) => hasClass(e, 'source'))
  const a = source && find(source, (e) => e.tagName === 'a')
  if (a) {
    const href = attr(a, 'data-notion-file') ?? attr(a, 'href') ?? ''
    const local = attr(a, 'data-notion-file') !== undefined || !isExternalHref(href)
    if (local) {
      const name = attr(a, 'data-notion-file-alias') ?? textOf(a).trim()
      const file: Block = {
        type: 'file',
        props: { url: ctx.file(href), name, ...(captionText ? { caption: captionText } : {}) },
        children: []
      }
      return [file]
    }
    const blocks = [linkParagraph(href, textOf(a).trim() || href, ctx)]
    if (captionText) blocks.push(paragraph([{ type: 'text', text: captionText, styles: {} }]))
    return blocks
  }
  return mapBlocks(el.children, ctx)
}

function image(url: string, caption: string): Block {
  return { type: 'image', props: { url, caption }, children: [] }
}

function imageOf(el: Element, ctx: MapContext): Block {
  return image(ctx.file(attr(el, 'src') ?? ''), attr(el, 'alt') ?? '')
}

/** The `<img>` elements of a paragraph that holds nothing else, or undefined. */
function paragraphImages(el: Element): Element[] | undefined {
  const parts = el.children.filter((n) => !(n.type === 'text' && n.value.trim() === ''))
  if (parts.length === 0 || !parts.every((n): n is Element => isElement(n, 'img'))) return undefined
  return parts
}

function mediaBlock(el: Element, ctx: MapContext, caption: string): Block[] {
  const source = find(el, (e) => e.tagName === 'source')
  const src = attr(el, 'src') ?? (source && attr(source, 'src'))
  if (!src) return skipped(el, ctx)
  const type = el.tagName === 'video' ? 'video' : 'audio'
  return [{ type, props: { url: ctx.file(src), caption }, children: [] }]
}

function linkParagraph(href: string, text: string, ctx: MapContext): Block {
  return paragraph([
    { type: 'link', href: ctx.link(href), content: [{ type: 'text', text, styles: {} }] }
  ])
}

function pageLinkBlock(el: Element, ctx: MapContext): Block {
  const a = find(el, (e) => e.tagName === 'a')
  const href = a ? ctx.link(attr(a, 'href') ?? '', attr(a, 'data-notion-page-id')) : ''
  if (pageIdFromHref(href)) return { type: 'pageLink', props: { href }, children: [] }
  // The page is not in the export: keep a plain link to it.
  const text = (a && textOf(a).trim()) || href
  return paragraph([{ type: 'link', href, content: [{ type: 'text', text, styles: {} }] }])
}

function mapDiv(el: Element, ctx: MapContext): Block[] {
  if (hasClass(el, 'column-list') || attr(el, 'data-notion-column-list') !== undefined) {
    const columns = elements(el).filter(
      (c) => hasClass(c, 'column') || attr(c, 'data-notion-column-ratio') !== undefined
    )
    return [
      {
        type: 'columnList',
        props: {},
        children: columns.map((c): Block => ({
          type: 'column',
          props: { width: columnWidth(c, columns.length) },
          children: mapBlocks(c.children, ctx)
        }))
      }
    ]
  }
  if (hasClass(el, 'collection-content') || hasClass(el, 'collection-content-wrapper')) {
    return mapCollection(el, ctx)
  }
  // Synced blocks, color wrappers and other containers: their content, inline.
  return mapBlocks(el.children, ctx)
}

/** Nobi column widths are relative weights; Notion's ratios sum to 1. */
function columnWidth(el: Element, count: number): number {
  const ratio = Number(attr(el, 'data-notion-column-ratio'))
  const percent = /width:\s*([\d.]+)%/.exec(attr(el, 'style') ?? '')
  const share = Number.isFinite(ratio) && ratio > 0 ? ratio : percent ? Number(percent[1]) / 100 : 0
  return share ? Math.round(share * count * 1000) / 1000 : 1
}

function mapCollection(el: Element, ctx: MapContext): Block[] {
  const out: Block[] = []
  const title = find(el, (e) => hasClass(e, 'collection-title'))
  if (title) out.push(heading(3, mapInline(title.children, ctx)))
  const table = find(el, (e) => e.tagName === 'table')
  if (table) out.push(mapTable(table, ctx))
  return out
}

// ---------- tables ----------

function findRows(table: Element): Element[] {
  const rows: Element[] = []
  for (const part of elements(table)) {
    if (part.tagName === 'tr') rows.push(part)
    else if (part.tagName === 'thead' || part.tagName === 'tbody' || part.tagName === 'tfoot') {
      rows.push(...elements(part).filter((r) => r.tagName === 'tr'))
    }
  }
  return rows
}

function mapTable(el: Element, ctx: MapContext): Block {
  const rows = findRows(el)
  const database = hasClass(el, 'collection-content')
  let headerColumn = false
  let colored = false
  const content: TableContent = {
    type: 'tableContent',
    rows: rows.map((row) => ({
      cells: elements(row)
        .filter((c) => c.tagName === 'td' || c.tagName === 'th')
        .map((cell) => {
          if (cell.tagName === 'th' && rows.indexOf(row) > 0) headerColumn = true
          if (!database && Object.keys(colorFromClasses(classes(cell), 'block-color-')).length) {
            colored = true
          }
          return cellInline(cell, ctx)
        })
    }))
  }
  if (headerColumn) ctx.issue('table', 'Header column (kept as a normal column)')
  if (colored) ctx.issue('table', 'Table cell colors')
  return { type: 'table', props: {}, content, children: [] }
}

function cellInline(cell: Element, ctx: MapContext): Inline[] {
  const nodes: ElementContent[] = []
  for (const child of cell.children) {
    // Property icons in database headers are decoration.
    if (isElement(child) && hasClass(child, 'property-icon')) continue
    const pill = isElement(child) && hasClass(child, 'selected-value')
    const last = nodes[nodes.length - 1]
    if (pill && isElement(last) && hasClass(last, 'selected-value')) {
      nodes.push({ type: 'text', value: ' ' })
    }
    nodes.push(child as ElementContent)
  }
  return mapInline(nodes, ctx)
}

// ---------- unknown content ----------

function describe(el: Element): string {
  const cls = classes(el).filter((c) => c && !c.startsWith('block-color-'))
  return cls.length ? `${el.tagName}.${cls.join('.')}` : el.tagName
}

function skipped(el: Element, ctx: MapContext): Block[] {
  ctx.issue('skipped', describe(el))
  return []
}

function unknown(el: Element, ctx: MapContext): Block[] {
  const text = textOf(el).trim()
  if (!text) return skipped(el, ctx)
  ctx.issue('unknown', describe(el))
  return text.split(/\n{2,}/).map((t) => paragraph([{ type: 'text', text: t, styles: {} }]))
}
