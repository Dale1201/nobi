import type { Block, BlockColors, Inline, StyledText, Styles } from '../core/blocks'
import { DEFAULT_CALLOUT_ICON } from '../core/blocks'
import { pageIdFromHref } from '../core/links'
import { normalizeInline } from '../core/normalize'
import { inlineText } from '../core/text'
import { notionColor } from './colors'
import type { MapContext } from './types'

// Notion's private clipboard format (`text/_notion-blocks-v3-production`): the copied blocks'
// records, each with its type, rich text, format and child ids.

export const NOTION_RECORDS_TYPE = 'text/_notion-blocks-v3-production'

type RichText = [string, Mark[]?][]
type Mark = [string, ...unknown[]]

const MAX_DEPTH = 64
// Bounds the work on records that share children, which can multiply without a cycle.
const MAX_BLOCKS = 20000
const MAX_NAME_TEXT = 2000

interface BlockRecord {
  id: string
  type: string
  properties?: Record<string, RichText | undefined>
  format?: Record<string, unknown>
  content?: string[]
}

export interface PasteNames {
  /** Notion page id (32 hex) -> its title, from the `text/html` copy. */
  pages: Map<string, string>
  /** Text of the `text/html` copy, to recover person names. */
  text: string
  /** The `text/html` copy mapped to blocks, for content the records leave out. */
  blocks: Block[]
}

/** The blocks a Notion copy holds, in order; null when the data is not Notion's format. */
export function mapNotionRecords(json: string, ctx: MapContext, names: PasteNames): Block[] | null {
  let data: unknown
  try {
    data = JSON.parse(json)
  } catch {
    return null
  }
  const list = (data as { blocks?: unknown } | null)?.blocks
  if (!Array.isArray(list)) return null
  const records = new Map<string, BlockRecord>()
  const top: string[] = []
  for (const item of list as {
    blockId?: string
    blockSubtree?: { block?: Record<string, unknown> }
  }[]) {
    if (typeof item?.blockId !== 'string') continue
    top.push(item.blockId)
    for (const [id, wrapped] of Object.entries(item.blockSubtree?.block ?? {})) {
      const value = unwrap(wrapped)
      if (value) records.set(id, { ...value, id })
    }
  }
  const mapper = new RecordMapper(records, ctx, names)
  const blocks = mapper.blocks(top, true)
  return mapper.complete ? blocks : null
}

function unwrap(wrapped: unknown): Omit<BlockRecord, 'id'> | null {
  let value = (wrapped as { value?: unknown })?.value
  // Newer record maps nest the record one level deeper.
  if (value && typeof value === 'object' && !('type' in value) && 'value' in value) {
    value = (value as { value: unknown }).value
  }
  return value && typeof value === 'object' && 'type' in value
    ? (value as Omit<BlockRecord, 'id'>)
    : null
}

class RecordMapper {
  /** False once a nested block turned out to have no record. */
  complete = true
  private readonly path = new Set<string>()
  private budget = MAX_BLOCKS
  private reportedDepth = false
  private readonly used = new Set<number>()
  private personTexts: string[] | null = null

  constructor(
    private readonly records: Map<string, BlockRecord>,
    private readonly ctx: MapContext,
    private readonly names: PasteNames
  ) {}

  /** Sub-pages and databases arrive at the top level without a record; nested ids must have one. */
  blocks(ids: string[], top = false): Block[] {
    const out: Block[] = []
    for (const [i, id] of ids.entries()) {
      const record = this.records.get(id)
      if (!record) {
        if (top) out.push(...this.pageReference(id))
        else this.complete = false
        continue
      }
      if (record.type === 'transclusion_container' && !this.hasContent(record)) {
        out.push(...this.syncedFromHtml(ids, i))
        continue
      }
      if (this.path.has(id) || this.path.size >= MAX_DEPTH || this.budget-- <= 0) {
        if (!this.reportedDepth) this.ctx.issue('skipped', 'Block nested too deeply')
        this.reportedDepth = true
        this.complete = false
        continue
      }
      this.path.add(id)
      try {
        out.push(...this.block(record))
      } finally {
        this.path.delete(id)
      }
    }
    return out
  }

  private hasContent(r: BlockRecord): boolean {
    return this.ids(r).every((id) => this.records.has(id))
  }

  private ids(r: BlockRecord): string[] {
    return Array.isArray(r.content) ? r.content.filter((id) => typeof id === 'string') : []
  }

  /**
   * A copied synced block carries only its container; its content is in the `text/html` copy,
   * between the blocks around it. The nearest siblings with text locate it; siblings without
   * text (dividers, images, tables) are skipped over, one HTML block each.
   */
  private syncedFromHtml(ids: string[], at: number): Block[] {
    const html = this.names.blocks
    // Patterns, not text: reading a record's text would consume person-name matches.
    const anchor = (id: string): Part[] | null => {
      const r = this.records.get(id)
      const pattern = r ? patternOf(segments(r.properties?.title)) : []
      return pattern.some((p) => typeof p === 'string' && p.replace('@', '').trim() !== '')
        ? pattern
        : null
    }
    let before = at - 1
    while (before >= 0 && anchor(ids[before]) === null) before--
    let after = at + 1
    while (after < ids.length && anchor(ids[after]) === null) after++
    const prev = before >= 0 ? anchor(ids[before]) : null
    const next = after < ids.length ? anchor(ids[after]) : null
    if (prev === null && next === null) return this.lostSynced()
    const skippedBefore = at - 1 - before
    const skippedAfter = after - at - 1
    let start = skippedBefore
    if (prev !== null) {
      const found = html.findIndex((b) => matchWhole(prev, ownText(b)) !== null)
      if (found < 0) return this.lostSynced()
      start = found + 1 + skippedBefore
    }
    let end = html.length - skippedAfter
    if (next !== null) {
      const found = html.findIndex((b, i) => i >= start && matchWhole(next, ownText(b)) !== null)
      if (found < 0) return this.lostSynced()
      end = found - skippedAfter
    }
    return end < start ? this.lostSynced() : html.slice(start, end)
  }

  private lostSynced(): Block[] {
    this.ctx.issue('skipped', 'Synced block (copy it from the original block)')
    return []
  }

  private children(r: BlockRecord): Block[] {
    return this.blocks(this.ids(r))
  }

  private text(r: BlockRecord, key = 'title'): Inline[] {
    return this.richText(r.properties?.[key])
  }

  private plain(r: BlockRecord, key: string): string {
    return segments(r.properties?.[key])
      .map(([text]) => text)
      .join('')
  }

  private colors(r: BlockRecord): BlockColors {
    return notionColor(str(r.format?.block_color))
  }

  private block(r: BlockRecord): Block[] {
    const colors = this.colors(r)
    const children = (): Block[] => this.children(r)
    switch (r.type) {
      case 'text':
        return [{ type: 'paragraph', props: colors, content: this.text(r), children: children() }]
      case 'header':
      case 'sub_header':
      case 'sub_sub_header':
      case 'header_4': {
        const level = { header: 1, sub_header: 2, sub_sub_header: 3, header_4: 4 }[r.type]
        const toggle = r.format?.toggleable === true
        return [
          {
            type: 'heading',
            props: { level, ...colors, ...(toggle ? { isToggleable: true } : {}) },
            content: this.text(r),
            children: children()
          }
        ]
      }
      case 'bulleted_list':
        return [
          { type: 'bulletListItem', props: colors, content: this.text(r), children: children() }
        ]
      case 'numbered_list':
        return [
          { type: 'numberedListItem', props: colors, content: this.text(r), children: children() }
        ]
      case 'to_do':
        return [
          {
            type: 'checkListItem',
            props: { checked: this.plain(r, 'checked') === 'Yes', ...colors },
            content: this.text(r),
            children: children()
          }
        ]
      case 'toggle':
        return [
          { type: 'toggleListItem', props: colors, content: this.text(r), children: children() }
        ]
      case 'quote':
        return [{ type: 'quote', props: colors, content: this.text(r), children: children() }]
      case 'callout':
        return [this.callout(r, colors)]
      case 'divider':
        return [{ type: 'divider', props: {}, children: [] }]
      case 'code': {
        const text = this.plain(r, 'title')
        const language = this.plain(r, 'language').toLowerCase().replace(/ /g, '') || 'text'
        return [
          {
            type: 'codeBlock',
            props: { language: language === 'plaintext' ? 'text' : language },
            content: text ? [{ type: 'text', text, styles: {} }] : [],
            children: []
          },
          ...this.caption(r)
        ]
      }
      case 'equation':
        return [{ type: 'math', props: { latex: this.plain(r, 'title') }, children: [] }]
      case 'table':
        return [this.table(r)]
      case 'column_list':
        return [{ type: 'columnList', props: {}, children: this.columns(r) }]
      case 'column':
        return children()
      case 'image':
      case 'video':
      case 'audio':
      case 'file':
      case 'pdf':
        return this.media(r)
      case 'bookmark':
        return [
          this.linkParagraph(this.plain(r, 'link'), this.plain(r, 'title')),
          ...this.caption(r)
        ]
      case 'embed':
      case 'figma':
      case 'tweet':
      case 'maps':
      case 'codepen':
      case 'gist':
        return [this.linkParagraph(this.plain(r, 'source'), ''), ...this.caption(r)]
      case 'table_of_contents':
        return [{ type: 'toc', props: {}, children: [] }]
      case 'transclusion_container':
        return children()
      case 'page':
      case 'collection_view_page':
      case 'collection_view':
        return this.pageReference(r.id, this.plain(r, 'title'))
      case 'alias': {
        const target = (r.format?.alias_pointer as { id?: unknown } | undefined)?.id
        return typeof target === 'string' ? this.pageReference(target) : []
      }
      default: {
        const text = this.text(r)
        if (text.length === 0 && this.ids(r).length === 0) {
          this.ctx.issue('skipped', r.type)
          return []
        }
        this.ctx.issue('unknown', r.type)
        return [{ type: 'paragraph', props: {}, content: text, children: children() }]
      }
    }
  }

  private callout(r: BlockRecord, colors: BlockColors): Block {
    const icon = str(r.format?.page_icon) ?? DEFAULT_CALLOUT_ICON
    let content = this.text(r)
    let kids = this.children(r)
    // Newer callouts keep their text in a first child paragraph.
    const lead = kids[0]
    if (
      content.length === 0 &&
      lead?.type === 'paragraph' &&
      Object.keys(lead.props).length === 0
    ) {
      content = lead.content
      kids = [...lead.children, ...kids.slice(1)]
    }
    const background =
      colors.backgroundColor || colors.textColor ? colors : { backgroundColor: 'gray' }
    return { type: 'callout', props: { icon, ...background }, content, children: kids }
  }

  private columns(r: BlockRecord): Block[] {
    const columns = this.childRecords(r)
    return columns.map((c) => {
      const ratio = Number(c.format?.column_ratio)
      const width = ratio > 0 ? Math.round(ratio * columns.length * 1000) / 1000 : 1
      return { type: 'column', props: { width }, children: this.children(c) }
    })
  }

  /** The records of a block's children; a child without one makes the records incomplete. */
  private childRecords(r: BlockRecord): BlockRecord[] {
    const found: BlockRecord[] = []
    for (const id of this.ids(r)) {
      const record = this.records.get(id)
      if (record) found.push(record)
      else this.complete = false
    }
    return found
  }

  private table(r: BlockRecord): Block {
    const order = Array.isArray(r.format?.table_block_column_order)
      ? (r.format.table_block_column_order as string[])
      : []
    const rows = this.childRecords(r).filter((row) => row.type === 'table_row')
    if (r.format?.table_block_row_header === true) {
      this.ctx.issue('table', 'Header column (kept as a normal column)')
    }
    return {
      type: 'table',
      props: {},
      content: {
        type: 'tableContent',
        rows: rows.map((row) => ({ cells: order.map((col) => this.text(row, col)) }))
      },
      children: []
    }
  }

  private media(r: BlockRecord): Block[] {
    const source = this.plain(r, 'source')
    const caption = this.plain(r, 'caption')
    const name = this.plain(r, 'title') || source.split('/').pop() || 'file'
    if (!/^https?:/i.test(source)) {
      // Uploaded files arrive as `attachment:<id>:<name>`; Notion gives no address to fetch.
      const label = r.type === 'image' ? 'Image' : 'File'
      this.ctx.issue('missingFile', name)
      const note: Block = {
        type: 'paragraph',
        props: {},
        content: [
          { type: 'text', text: `${label} from Notion: ${name}`, styles: { italic: true } }
        ],
        children: []
      }
      return [note, ...this.caption(r)]
    }
    const url = this.ctx.file(source)
    if (r.type === 'image' || r.type === 'video' || r.type === 'audio') {
      return [{ type: r.type, props: { url, caption }, children: [] }]
    }
    return [this.linkParagraph(source, name), ...this.caption(r)]
  }

  /** A caption as its own paragraph, for blocks that have no caption of their own. */
  private caption(r: BlockRecord): Block[] {
    const content = this.text(r, 'caption')
    if (inlineText(content).trim() === '') return []
    return [{ type: 'paragraph', props: {}, content, children: [] }]
  }

  private linkParagraph(href: string, text: string): Block {
    const label: StyledText = { type: 'text', text: text || href, styles: {} }
    return {
      type: 'paragraph',
      props: {},
      content: href ? [{ type: 'link', href: this.ctx.link(href), content: [label] }] : [label],
      children: []
    }
  }

  private pageReference(id: string, title?: string): Block[] {
    const notionId = id.replace(/-/g, '')
    const href = this.ctx.link(`https://www.notion.so/${notionId}`, id)
    const name = title || this.names.pages.get(notionId) || 'Untitled'
    if (pageIdFromHref(href)) return [{ type: 'pageLink', props: { href }, children: [] }]
    return [this.linkParagraph(href, name)]
  }

  // ---------- rich text ----------

  private richText(rich: RichText | undefined): Inline[] {
    const segs = segments(rich)
    const out: Inline[] = []
    const people = this.personNames(segs)
    for (const [text, marks] of segs) {
      const styles: Styles = {}
      let href: string | null = null
      let replaced: Inline | null = null
      for (const [mark, arg] of marks) {
        switch (mark) {
          case 'b':
            styles.bold = true
            break
          case 'i':
            styles.italic = true
            break
          case '_':
            styles.underline = true
            break
          case 's':
            styles.strike = true
            break
          case 'c':
            styles.code = true
            break
          case 'h':
            Object.assign(styles, notionColor(str(arg)))
            break
          case 'a':
            href = this.ctx.link(String(arg))
            break
          case 'e':
            replaced = { type: 'inlineMath', props: { latex: String(arg) } }
            break
          case 'p': {
            const id = String(arg)
            const notionId = id.replace(/-/g, '')
            const link = this.ctx.link(`https://www.notion.so/${notionId}`, id)
            const title = this.names.pages.get(notionId) ?? 'Untitled'
            if (pageIdFromHref(link)) {
              replaced = { type: 'pageMention', props: { href: link, title } }
            } else {
              href = link
              replaced = this.styled(title, styles)
            }
            break
          }
          case 'u':
            replaced = this.styled(`@${people.shift() ?? 'Someone'}`, styles)
            break
          case 'd':
            replaced = this.styled(`@${formatDate(arg as NotionDate)}`, styles)
            break
          case 'lm': {
            const link = arg as { href?: unknown; title?: unknown } | undefined
            const target = str(link?.href)
            if (target) {
              href = this.ctx.link(target)
              replaced = this.styled(str(link?.title) || target, styles)
            }
            break
          }
        }
      }
      // A mention this mapper does not know would leave only its placeholder.
      if (!replaced && text === '‣') this.complete = false
      const item = replaced ?? this.styled(text, styles)
      if (href && item.type === 'text') out.push({ type: 'link', href, content: [item] })
      else out.push(item)
    }
    return normalizeInline(out)
  }

  private styled(text: string, styles: Styles): StyledText {
    return { type: 'text', text, styles: { ...styles } }
  }

  /**
   * Notion's records name people only by id; the `text/html` copy has their names. The rich
   * text is matched against each HTML block's own text, in document order, taking blocks that
   * no earlier mention used first.
   */
  private personNames(rich: Segment[]): string[] {
    if (!rich.some(([, marks]) => marks.some(([m]) => m === 'u'))) return []
    const pattern = patternOf(rich)
    const texts = this.personTexts ?? (this.personTexts = personTexts(this.names.blocks))
    let fallback: string[] | null = null
    for (const [i, text] of texts.entries()) {
      const people = matchWhole(pattern, text)
      if (!people) continue
      if (!this.used.has(i)) {
        this.used.add(i)
        return people
      }
      fallback ??= people
    }
    return fallback ?? []
  }
}

interface NotionDate {
  start_date?: string
  end_date?: string
  start_time?: string
  end_time?: string
}

function formatDate(date: NotionDate | undefined): string {
  const one = (day?: string, time?: string): string => {
    if (!day) return ''
    const d = new Date(`${day}T00:00:00Z`)
    const text = d.toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC'
    })
    return time ? `${text} ${time}` : text
  }
  const start = one(date?.start_date, date?.start_time)
  const end = one(date?.end_date, date?.end_time)
  return end ? `${start} → ${end}` : start
}

type Segment = [string, Mark[]]
/** A literal, or a gap: any text, and for a person (`person`) at least one character, captured. */
type Part = string | { person?: boolean }

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Rich text with whatever is malformed dropped. */
function segments(rich: unknown): Segment[] {
  if (!Array.isArray(rich)) return []
  const out: Segment[] = []
  for (const seg of rich as unknown[]) {
    if (!Array.isArray(seg)) continue
    const marks = Array.isArray(seg[1])
      ? (seg[1] as unknown[]).filter((m): m is Mark => Array.isArray(m))
      : []
    out.push([str(seg[0]) ?? '', marks])
  }
  return out
}

function ownText(block: Block): string {
  return 'content' in block && Array.isArray(block.content)
    ? inlineText(block.content as Inline[]).trim()
    : ''
}

/** The own text of every block of the HTML copy, children included, that is short enough to match. */
function personTexts(blocks: Block[]): string[] {
  const out: string[] = []
  const walk = (list: Block[]): void => {
    for (const block of list) {
      if (block.type === 'table') {
        for (const row of block.content.rows) {
          for (const cell of row.cells) {
            out.push(inlineText(Array.isArray(cell) ? cell : cell.content).trim())
          }
        }
      } else {
        out.push(ownText(block))
      }
      walk(block.children)
    }
  }
  walk(blocks)
  return out.map((text) => (text.length > MAX_NAME_TEXT ? '' : text))
}

/**
 * The text of rich text as literals and gaps: a person is "@" and a captured gap, other
 * mentions a gap. The HTML block texts are trimmed, so the pattern's ends are too.
 */
function patternOf(rich: Segment[]): Part[] {
  const parts: Part[] = []
  const add = (part: Part): void => {
    const last = parts[parts.length - 1]
    if (typeof part === 'string' && typeof last === 'string') parts[parts.length - 1] = last + part
    else parts.push(part)
  }
  for (const [text, marks] of rich) {
    if (marks.some(([m]) => m === 'u')) {
      add('@')
      add({ person: true })
    } else if (marks.some(([m]) => m === 'p' || m === 'd' || m === 'e' || m === 'lm')) add({})
    else add(text)
  }
  const first = parts[0]
  if (typeof first === 'string') parts[0] = first.trimStart()
  const last = parts[parts.length - 1]
  if (typeof last === 'string') parts[parts.length - 1] = last.trimEnd()
  return parts.filter((part) => part !== '')
}

/**
 * Matches `text` against a pattern from start to end, returning what the person gaps
 * captured. A gap runs only to the next literal's first occurrence, so it never backtracks.
 */
function matchWhole(merged: Part[], text: string): string[] | null {
  const people: string[] = []
  let pos = 0
  for (let i = 0; i < merged.length; i++) {
    const part = merged[i]
    if (typeof part === 'string') {
      if (!text.startsWith(part, pos)) return null
      pos += part.length
      continue
    }
    const min = part.person ? 1 : 0
    const next = merged[i + 1]
    let end: number
    if (next === undefined) end = text.length
    // Where a person's name ends is unknowable before another gap.
    else if (typeof next !== 'string') {
      if (part.person) return null
      end = pos
    } else if (i + 1 === merged.length - 1) end = text.length - next.length
    else end = text.indexOf(next, pos + min)
    if (end < pos + min || end > text.length) return null
    if (part.person) people.push(text.slice(pos, end))
    pos = end
  }
  return pos === text.length ? people : null
}
