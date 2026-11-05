import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Block } from '../../shared/core/blocks'
import {
  mapBlockLinks,
  pageIdFromHref,
  pageLinkHref,
  refreshMentionTitles
} from '../../shared/core/links'
import { parsePage, type PageMeta } from '../../shared/core/page'
import {
  decodeHref,
  encodeHref,
  isExternalHref,
  relativeHref,
  resolveHref,
  sanitizeTitle,
  stemOf
} from '../../shared/core/paths'
import { blocksText } from '../../shared/core/text'
import type { PageDoc } from '../../shared/types'
import { SearchIndex } from '../search/index'
import { LinkGraph } from './backlinks'
import { uniqueName, writeFileAtomic } from './fs-utils'
import { ROOT_ORDER_KEY, saveState, serializeState, type WorkspaceState } from './state'

export const ATTACHMENTS_DIR = 'attachments'

export interface PageRecord {
  id: string
  title: string
  icon?: string
  path: string
  parentId: string | null
}

export type WorkspaceEvent = { type: 'tree' } | { type: 'page'; id: string; revision: number }

/** The page maps every part of a workspace shares; only used from inside `Workspace.run`. */
export class WorkspaceCore {
  pages = new Map<string, PageRecord>()
  /** Last known path of every id ever seen, so links to trashed pages still serialize. */
  readonly knownPaths = new Map<string, string>()
  /** Last text read or written for each page path; lets renames skip pages that cannot link. */
  texts = new Map<string, string>()
  /** `mtime:size` of each page file when last read, so rescans skip unchanged files. */
  stats = new Map<string, string>()
  /** Bumped when content changes other than through `writePage`, so stale editors are refused. */
  readonly revisions = new Map<string, number>()
  /** Pages whose current text the app wrote this session. */
  readonly owned = new Set<string>()
  /** Page files this session created for folders that had none; removed again if the folder goes away untouched. */
  readonly stubs = new Map<string, string>()
  readonly lastSnapshot = new Map<string, number>()
  readonly listeners = new Set<(event: WorkspaceEvent) => void>()
  stateText = ''
  readonly index = new SearchIndex()
  readonly links = new LinkGraph()

  constructor(
    readonly root: string,
    public state: WorkspaceState,
    readonly now: () => Date,
    private readonly onOutsideEdit: (r: PageRecord, text: string) => Promise<void>
  ) {}

  emit(event: WorkspaceEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  abs(path: string): string {
    return join(this.root, ...path.split('/'))
  }

  /** Reads a page file, treating text the app has not seen as an external change. */
  async readCurrent(r: PageRecord): Promise<string> {
    const text = await readFile(this.abs(r.path), 'utf8')
    const known = this.texts.get(r.path)
    if (known !== undefined && known !== text) await this.onOutsideEdit(r, text)
    else this.remember(r.path, text)
    return text
  }

  async writeText(path: string, text: string): Promise<void> {
    await writeFileAtomic(this.abs(path), text)
    this.remember(path, text)
  }

  /** The `texts` cache changed: the recorded file stat no longer describes it. */
  remember(path: string, text: string): void {
    this.texts.set(path, text)
    this.stats.delete(path)
  }

  revision(id: string): number {
    return this.revisions.get(id) ?? 0
  }

  async persist(): Promise<void> {
    this.stateText = serializeState(this.state)
    await saveState(this.root, this.state)
  }

  indexText(r: PageRecord, text: string): void {
    this.indexBlocks(r, text, parsePage(text).blocks)
  }

  /** Indexes a page from blocks already parsed out of its file text. */
  indexBlocks(r: PageRecord, text: string, fileBlocks: Block[]): void {
    this.index.set(r.id, r.title, blocksText(fileBlocks))
    this.links.note(r.path, text, fileBlocks)
  }

  // ---------- tree ----------

  /** Every parent's children in sidebar order, built in one pass. */
  groupChildren(): Map<string | null, PageRecord[]> {
    const groups = new Map<string | null, PageRecord[]>()
    for (const r of this.pages.values()) {
      const list = groups.get(r.parentId)
      if (list) list.push(r)
      else groups.set(r.parentId, [r])
    }
    for (const [parentId, kids] of groups) {
      const order = this.state.order[parentId ?? ROOT_ORDER_KEY] ?? []
      const rank = new Map(order.map((id, i) => [id, i]))
      const at = (r: PageRecord): number => rank.get(r.id) ?? Number.MAX_SAFE_INTEGER
      kids.sort(
        (a, b) => at(a) - at(b) || a.title.localeCompare(b.title, undefined, { numeric: true })
      )
    }
    return groups
  }

  childrenOf(parentId: string | null): PageRecord[] {
    return this.groupChildren().get(parentId) ?? []
  }

  record(id: string): PageRecord {
    const r = this.pages.get(id)
    if (!r) throw new Error(`Unknown page ${id}`)
    return r
  }

  descendantsOf(id: string): PageRecord[] {
    const groups = this.groupChildren()
    const out: PageRecord[] = []
    const walk = (parentId: string): void => {
      for (const child of groups.get(parentId) ?? []) {
        out.push(child)
        walk(child.id)
      }
    }
    walk(id)
    return out
  }

  pageStem(dir: string, title: string, allow?: string): Promise<string> {
    return uniqueName(this.abs(dir), sanitizeTitle(title), '.md', {
      allow,
      reserved: dir === '' ? [ATTACHMENTS_DIR] : []
    })
  }

  // ---------- ordering ----------

  insertOrder(parentId: string | null, id: string, index?: number): void {
    const key = parentId ?? ROOT_ORDER_KEY
    const current = this.childrenOf(parentId)
      .map((r) => r.id)
      .filter((x) => x !== id)
    const at = index === undefined ? current.length : Math.max(0, Math.min(index, current.length))
    current.splice(at, 0, id)
    this.state.order[key] = current
  }

  removeOrder(parentId: string | null, id: string): void {
    const key = parentId ?? ROOT_ORDER_KEY
    const list = this.state.order[key]
    if (list) this.state.order[key] = list.filter((x) => x !== id)
  }

  // ---------- href translation between disk and editor ----------

  /** A page as the editor sees it, with links resolved against the file at `path`. */
  toDoc(path: string, text: string, linkIds: Record<string, string> = {}): PageDoc {
    const { meta, blocks, frontmatterError } = parsePage(text)
    const byPath = this.pathIndex()
    for (const [target, id] of Object.entries(linkIds)) {
      if (this.pages.has(id)) byPath.set(target, id)
    }
    return {
      id: meta.id ?? '',
      title: meta.title ?? stemOf(path),
      path,
      meta: this.metaToInternal(path, meta, byPath),
      blocks: mapBlockLinks(blocks, (href) => this.toInternalHref(path, href, byPath)),
      revision: 0,
      ...(frontmatterError ? { frontmatterError } : {})
    }
  }

  /** The id of every page the file at `path` links to, by the workspace path it links with. */
  linkIds(path: string, text: string, byPath: Map<string, string>): Record<string, string> {
    const links: Record<string, string> = {}
    const { meta, blocks } = parsePage(text)
    const note = (href: string): string => {
      if (!isExternalHref(href)) {
        const target = resolveHref(path, href)
        const id = byPath.get(target)
        if (id) links[target] = id
      }
      return href
    }
    mapBlockLinks(blocks, note)
    if (meta.cover) note(meta.cover)
    return links
  }

  pathIndex(): Map<string, string> {
    return new Map([...this.pages.values()].map((r) => [r.path, r.id]))
  }

  private toInternalHref(pagePath: string, href: string, byPath: Map<string, string>): string {
    if (isExternalHref(href)) return href
    const target = resolveHref(pagePath, href)
    const id = byPath.get(target)
    return id ? pageLinkHref(id) : '/' + encodeHref(target)
  }

  /** Blocks as written to `pagePath`: page links become relative and mentions carry current titles. */
  toFileBlocks(pagePath: string, blocks: Block[]): Block[] {
    const titled = refreshMentionTitles(blocks, (href) => {
      const id = pageIdFromHref(href)
      return id ? this.pages.get(id)?.title : undefined
    })
    return mapBlockLinks(titled, (href) => this.toFileHref(pagePath, href))
  }

  toFileHref(pagePath: string, href: string): string {
    const pageId = pageIdFromHref(href)
    if (pageId) {
      const target = this.pages.get(pageId)?.path ?? this.knownPaths.get(pageId)
      return target ? relativeHref(pagePath, target) : href
    }
    if (href.startsWith('/') && !href.startsWith('//'))
      return relativeHref(pagePath, decodeHref(href))
    return href
  }

  private metaToInternal(pagePath: string, meta: PageMeta, byPath: Map<string, string>): PageMeta {
    return {
      ...meta,
      icon: iconToInternal(pagePath, meta.icon),
      cover: meta.cover ? this.toInternalHref(pagePath, meta.cover, byPath) : undefined
    }
  }

  metaHrefToFile(pagePath: string, icon: string): string {
    return icon.startsWith('/') ? this.toFileHref(pagePath, icon) : icon
  }
}

/** Image icons are kept as workspace paths so they survive the page moving. */
export function iconToInternal(pagePath: string, icon: string | undefined): string | undefined {
  if (!icon || !icon.includes('/') || isExternalHref(icon)) return icon
  return '/' + encodeHref(resolveHref(pagePath, icon))
}

export async function fileStat(
  path: string
): Promise<{ key: string; mtime: number; born: number }> {
  const s = await stat(path)
  return { key: `${s.mtimeMs}:${s.size}`, mtime: s.mtimeMs, born: s.birthtimeMs }
}
