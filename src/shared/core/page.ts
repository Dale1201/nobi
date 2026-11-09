import { isMap, parse as parseYaml, parseDocument, stringify as stringifyYaml } from 'yaml'
import type { Block } from './blocks'
import { markdownToBlocks } from './parse'
import { blocksToMarkdown } from './serialize'

/** Page ids become folder names under `.nobi/`, so only these characters are accepted. */
export const PAGE_ID = /^[\w-]+$/

export interface PageMeta {
  id?: string
  title?: string
  icon?: string
  cover?: string
  coverPosition?: number
  fullWidth?: boolean
  /** Frontmatter keys Nobi does not know, written back untouched. */
  extra: Record<string, unknown>
}

export interface ParsedPage {
  meta: PageMeta
  blocks: Block[]
  /** The file starts with a frontmatter block that is not valid YAML; it is kept as a raw block. */
  frontmatterError?: boolean
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

export function splitFrontmatter(raw: string): {
  data: Record<string, unknown> | null
  body: string
} {
  const text = raw.replace(/^\uFEFF/, '')
  const m = FRONTMATTER.exec(text)
  if (!m) return { data: {}, body: text }
  try {
    const data = parseYaml(m[1]) ?? {}
    if (typeof data !== 'object' || Array.isArray(data)) return { data: null, body: text }
    return {
      data: data as Record<string, unknown>,
      body: text.slice(m[0].length).replace(/^\r?\n/, '')
    }
  } catch {
    // Invalid YAML: keep the whole text as body so nothing is lost.
    return { data: null, body: text }
  }
}

export function metaFromData(data: Record<string, unknown>): PageMeta {
  const meta: PageMeta = { extra: {} }
  const scalar = (v: unknown): string | undefined =>
    typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined
  for (const [key, value] of Object.entries(data)) {
    const text = scalar(value)
    const number = typeof value === 'number' ? value : Number(text)
    if (key === 'id' && text !== undefined && PAGE_ID.test(text)) meta.id = text
    else if (key === 'title' && text !== undefined) meta.title = text
    else if (key === 'icon' && text !== undefined) meta.icon = text
    else if (key === 'cover' && text !== undefined) meta.cover = text
    else if (key === 'coverPosition' && text !== undefined && Number.isFinite(number))
      meta.coverPosition = number
    else if (key === 'fullWidth' && typeof value === 'boolean') meta.fullWidth = value
    // Values Nobi cannot interpret are kept as they are.
    else meta.extra[key] = value
  }
  return meta
}

export function parsePage(text: string): ParsedPage {
  const { data, body } = splitFrontmatter(text)
  const meta = data ? metaFromData(data) : { extra: {} }
  // Broken frontmatter is either the whole header, or sits below the id header the app added.
  const broken = FRONTMATTER.exec(body)
  if (broken && !isYamlMap(broken[1])) {
    const rest = body.slice(broken[0].length).replace(/^\r?\n/, '')
    return {
      meta,
      blocks: [
        { type: 'raw', props: { markdown: broken[0].replace(/\r?\n$/, '') }, children: [] },
        ...markdownToBlocks(rest)
      ],
      frontmatterError: true
    }
  }
  return { meta, blocks: markdownToBlocks(body) }
}

function isYamlMap(yaml: string): boolean {
  try {
    const data = parseYaml(yaml) ?? {}
    return typeof data === 'object' && !Array.isArray(data)
  } catch {
    return false
  }
}

/**
 * Adds an id to a page file without touching anything else: existing frontmatter keeps its
 * comments and formatting, and the body bytes stay exactly as they were.
 */
export function insertId(raw: string, id: string): string {
  const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : ''
  const text = raw.slice(bom.length)
  const m = FRONTMATTER.exec(text)
  if (m) {
    const doc = parseDocument(m[1])
    if (doc.errors.length === 0 && (doc.contents === null || isMap(doc.contents))) {
      // Edit the text, not the parsed document, so formatting and comments stay identical.
      const line = `id: ${id}`
      const yaml = /^id:.*$/m.test(m[1])
        ? m[1].replace(/^id:.*$/m, line)
        : m[1].trim() === ''
          ? line
          : `${m[1]}\n${line}`
      return `${bom}---\n${yaml}\n---\n${text.slice(m[0].length)}`
    }
  }
  const front = `---\nid: ${id}\n---\n`
  return text === '' ? bom + front : `${bom}${front}\n${text}`
}

export function serializePage(meta: PageMeta, blocks: Block[]): string {
  const data: Record<string, unknown> = {}
  if (meta.id) data.id = meta.id
  if (meta.title !== undefined) data.title = meta.title
  if (meta.icon) data.icon = meta.icon
  if (meta.cover) data.cover = meta.cover
  if (meta.cover && meta.coverPosition !== undefined) data.coverPosition = meta.coverPosition
  if (meta.fullWidth) data.fullWidth = true
  for (const [key, value] of Object.entries(meta.extra)) if (!(key in data)) data[key] = value
  const body = blocksToMarkdown(blocks)
  const front = Object.keys(data).length ? `---\n${stringifyYaml(data)}---\n` : ''
  if (!front) return body
  return body ? `${front}\n${body}` : front
}
