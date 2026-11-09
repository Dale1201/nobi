import type { Block, Inline } from './blocks'

export const PAGE_LINK_PREFIX = 'nobi://page/'
// The app was called Nobsidian; its page links may still be in notes and in old MCP clients.
const LEGACY_PAGE_LINK_PREFIX = 'nobsidian://page/'

export function pageLinkHref(id: string): string {
  return PAGE_LINK_PREFIX + id
}

export function pageIdFromHref(href: string): string | null {
  if (href.startsWith(PAGE_LINK_PREFIX)) return href.slice(PAGE_LINK_PREFIX.length)
  if (href.startsWith(LEGACY_PAGE_LINK_PREFIX)) return href.slice(LEGACY_PAGE_LINK_PREFIX.length)
  return null
}

/** Returns copies of `blocks` with every link target passed through `map`. */
export function mapBlockLinks(blocks: Block[], map: (href: string) => string): Block[] {
  return blocks.map((block) => mapBlock(block, map))
}

function mapBlock(block: Block, map: (href: string) => string): Block {
  const children = mapBlockLinks(block.children, map)
  switch (block.type) {
    case 'image':
    case 'video':
    case 'audio':
    case 'file':
    case 'drawing':
      return {
        ...block,
        props: { ...block.props, url: mapNonEmpty(block.props.url, map) },
        children
      } as Block
    case 'pageLink':
      return {
        ...block,
        props: { ...block.props, href: mapNonEmpty(block.props.href, map) },
        children
      }
    case 'table':
      return {
        ...block,
        content: {
          ...block.content,
          rows: block.content.rows.map((row) => ({
            cells: row.cells.map((cell) =>
              Array.isArray(cell)
                ? mapInline(cell, map)
                : { ...cell, content: mapInline(cell.content, map) }
            )
          }))
        },
        children
      }
    default:
      if ('content' in block && Array.isArray(block.content) && block.type !== 'codeBlock') {
        return { ...block, content: mapInline(block.content as Inline[], map), children } as Block
      }
      return { ...block, children } as Block
  }
}

function mapInline(content: Inline[], map: (href: string) => string): Inline[] {
  return content.map((item) => {
    if (item.type === 'link') return { ...item, href: mapNonEmpty(item.href, map) }
    if (item.type === 'pageMention') {
      return { ...item, props: { ...item.props, href: mapNonEmpty(item.props.href, map) } }
    }
    return item
  })
}

/** Returns copies of `blocks` with every inline item, table cells included, passed through `map`. */
export function mapBlockInline(blocks: Block[], map: (item: Inline) => Inline): Block[] {
  return blocks.map((block) => {
    const children = mapBlockInline(block.children, map)
    if (block.type === 'table') {
      return {
        ...block,
        content: {
          ...block.content,
          rows: block.content.rows.map((row) => ({
            cells: row.cells.map((cell) =>
              Array.isArray(cell) ? cell.map(map) : { ...cell, content: cell.content.map(map) }
            )
          }))
        },
        children
      }
    }
    if ('content' in block && Array.isArray(block.content) && block.type !== 'codeBlock') {
      return { ...block, content: (block.content as Inline[]).map(map), children } as Block
    }
    return { ...block, children } as Block
  })
}

export function refreshMentionTitles(
  blocks: Block[],
  titleOf: (href: string) => string | undefined
): Block[] {
  return mapBlockInline(blocks, (item) => {
    if (item.type !== 'pageMention') return item
    const title = titleOf(item.props.href)
    return title === undefined || title === item.props.title
      ? item
      : { ...item, props: { ...item.props, title } }
  })
}

function mapNonEmpty(href: string, map: (href: string) => string): string {
  return href === '' ? href : map(href)
}
