import { mkdir, readFile, stat } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { basename, extname, join } from 'node:path'
import type { Block } from '../../shared/core/blocks'
import { DRAWING_SUFFIX, isDrawingHref } from '../../shared/core/drawing'
import { mapBlockLinks, pageIdFromHref, pageLinkHref } from '../../shared/core/links'
import { parsePage, serializePage, splitFrontmatter, type PageMeta } from '../../shared/core/page'
import {
  childDirOf,
  decodeHref,
  dirOf,
  encodeHref,
  joinPath,
  sanitizeTitle,
  stemOf
} from '../../shared/core/paths'
import {
  appendSubPageLink,
  insertSubPageLinkAfter,
  removeSubPageLinks
} from '../../shared/core/subpages'
import { blocksText } from '../../shared/core/text'
import type {
  FileChange,
  HistoryVersion,
  ImportResult,
  PageDoc,
  PageMetaPatch,
  PageNode,
  SearchHit,
  TrashItem,
  WriteResult
} from '../../shared/types'
import { ATTACHMENTS_DIR, WorkspaceCore, type PageRecord, type WorkspaceEvent } from './core'
import { ExternalChanges, SETTLE_MS } from './external'
import { removeDirIfEmpty, uniqueName, writeFileAtomic } from './fs-utils'
import { LinkRewriter } from './links'
import { PageHistory } from './page-history'
import { PageImports } from './page-import'
import type { ImportManifest } from '../import/types'
import { PageTrash } from './page-trash'
import { APP_DIR, STATE_FILE, loadState, type WorkspaceState } from './state'

export type { WorkspaceEvent } from './core'

export interface WorkspaceOptions {
  now?: () => Date
  /** How long a file must go unmodified before the app adds an id line to it. */
  settleMs?: number
}

export class Workspace {
  private indexing: Promise<void> = Promise.resolve()
  private queue: Promise<unknown> = Promise.resolve()
  private readonly core: WorkspaceCore
  private readonly history: PageHistory
  private readonly external: ExternalChanges
  private readonly links: LinkRewriter
  private readonly trash: PageTrash
  private readonly imports: PageImports

  private constructor(
    readonly root: string,
    state: WorkspaceState,
    options: WorkspaceOptions
  ) {
    const now = options.now ?? (() => new Date())
    this.core = new WorkspaceCore(root, state, now, (r, text) =>
      this.external.applyExternal(r, text)
    )
    this.history = new PageHistory(this.core)
    this.external = new ExternalChanges(
      this.core,
      this.history,
      options.settleMs ?? SETTLE_MS,
      (task) => this.run(task)
    )
    this.links = new LinkRewriter(this.core, this.history)
    this.trash = new PageTrash(this.core, this.external, this.links, this.history, (id, edit) =>
      this.editBlocks(id, edit)
    )
    this.imports = new PageImports(this.core)
  }

  static async open(root: string, options: WorkspaceOptions = {}): Promise<Workspace> {
    // Never recreate a missing folder: it may be on an unmounted drive or have been moved.
    const info = await stat(root).catch(() => null)
    if (!info?.isDirectory()) throw new Error(`Folder not found: ${root}`)
    const ws = new Workspace(root, await loadState(root), options)
    ws.core.stateText = await readFile(join(root, APP_DIR, STATE_FILE), 'utf8').catch(() => '')
    await ws.external.scan()
    for (const r of ws.core.pages.values()) ws.core.index.setTitle(r.id, r.title)
    return ws
  }

  /** Stops background work; the workspace is not used after this. */
  close(): void {
    this.external.close()
    this.core.listeners.clear()
  }

  onEvent(listener: (event: WorkspaceEvent) => void): () => void {
    this.core.listeners.add(listener)
    return () => this.core.listeners.delete(listener)
  }

  /** Runs mutations one at a time so autosaves never interleave with renames. */
  private run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task)
    this.queue = next.catch(() => {})
    return next
  }

  /** Indexes every page's text for search in the background; searches wait for it. */
  indexContent(): Promise<void> {
    this.indexing = this.indexAll()
    return this.indexing
  }

  private async indexAll(): Promise<void> {
    let done = 0
    for (const id of [...this.core.pages.keys()]) {
      const r = this.core.pages.get(id)
      const text = r && this.core.texts.get(r.path)
      if (r && text !== undefined) this.core.indexText(r, text)
      if (++done % 50 === 0) await new Promise((resolve) => setImmediate(resolve))
    }
  }

  /** Prunes old history and purges expired trash; runs in the background after opening. */
  async maintain(): Promise<void> {
    await this.history.store.prune()
    await this.run(async () => {
      for (const entry of await this.trash.store.expired()) await this.trash.delete(entry.entry)
      await this.imports.removeStale()
    })
  }

  reconcile(changes: FileChange[]): Promise<void> {
    return this.run(() => this.external.reconcile(changes))
  }

  // ---------- queries ----------

  tree(): PageNode[] {
    const groups = this.core.groupChildren()
    const build = (parentId: string | null): PageNode[] =>
      (groups.get(parentId) ?? []).map((r) => ({
        id: r.id,
        title: r.title,
        icon: r.icon,
        path: r.path,
        children: build(r.id)
      }))
    return build(null)
  }

  favorites(): string[] {
    return this.core.state.favorites.filter((id) => this.core.pages.has(id))
  }

  async search(query: string): Promise<SearchHit[]> {
    await this.indexing
    return this.core.index.search(query).filter((hit) => this.core.pages.has(hit.id))
  }

  /** Pages that link to `id`, by title; a parent's sub-page block alone does not count. */
  async backlinks(id: string): Promise<string[]> {
    await this.indexing
    const core = this.core
    const target = core.pages.get(id)
    if (!target) return []
    const out: PageRecord[] = []
    for (const r of core.pages.values()) {
      const text = core.texts.get(r.path)
      if (r.id === id || text === undefined) continue
      const onlyBlocks = core.links.targetsOf(r.path, text).get(target.path)
      if (onlyBlocks === undefined || (onlyBlocks && target.parentId === r.id)) continue
      out.push(r)
    }
    return out
      .sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }))
      .map((r) => r.id)
  }

  // ---------- reading and writing ----------

  /** Queued like writes, so a page never loads content that a pending save is replacing. */
  readPage(id: string): Promise<PageDoc> {
    return this.run(async () => {
      const r = this.core.record(id)
      const text = await this.core.readCurrent(r)
      return {
        ...this.core.toDoc(r.path, text),
        id,
        title: r.title,
        revision: this.core.revision(id)
      }
    })
  }

  /**
   * Saves the editor's blocks. Refused when the page changed underneath the editor since it
   * loaded `revision`, unless `force` (the user chose to keep their version).
   */
  writePage(
    id: string,
    blocks: Block[],
    options: { revision?: number; force?: boolean } = {}
  ): Promise<WriteResult> {
    return this.run(async () => {
      const r = this.core.pages.get(id)
      const disk = r ? await this.core.readCurrent(r).catch(() => null) : null
      if (!r || disk === null) {
        await this.history.saveDraft(id, blocks)
        return { ok: false, reason: 'gone' }
      }
      const revision = this.core.revision(id)
      if (options.revision !== undefined && options.revision !== revision && !options.force) {
        return { ok: false, reason: 'conflict' }
      }
      const { meta } = parsePage(disk)
      const fileBlocks = this.core.toFileBlocks(r.path, blocks)
      await this.history.writeOwn(r, disk, serializePage({ ...meta, id }, fileBlocks))
      this.core.indexBlocks(r, this.core.texts.get(r.path) ?? '', fileBlocks)
      return { ok: true, revision }
    })
  }

  /** A page with a version that changes whenever its file does, for writers other than the editor. */
  readVersioned(id: string): Promise<{ doc: PageDoc; version: string }> {
    return this.run(async () => {
      const r = this.core.record(id)
      const text = await this.core.readCurrent(r)
      const revision = this.core.revision(id)
      const doc: PageDoc = { ...this.core.toDoc(r.path, text), id, title: r.title, revision }
      return { doc, version: textVersion(text) }
    })
  }

  /**
   * Changes a page's blocks for a writer other than the editor, such as Claude: the text it
   * replaces goes to history, and open editors reload or show a conflict. Refused when the file
   * no longer has `version`.
   */
  writeOutside(
    id: string,
    edit: (blocks: Block[]) => Block[],
    version?: string
  ): Promise<{ ok: true; version: string } | { ok: false; reason: 'conflict' }> {
    return this.run(async () => {
      const core = this.core
      const r = core.record(id)
      const disk = await core.readCurrent(r)
      if (version !== undefined && textVersion(disk) !== version) {
        return { ok: false, reason: 'conflict' }
      }
      const fileBlocks = core.toFileBlocks(r.path, edit(core.toDoc(r.path, disk).blocks))
      const text = serializePage({ ...parsePage(disk).meta, id }, fileBlocks)
      await this.history.snapshot(id, disk, r.path)
      core.owned.add(id)
      await core.writeText(r.path, text)
      core.indexBlocks(r, text, fileBlocks)
      const revision = core.revision(id) + 1
      core.revisions.set(id, revision)
      core.emit({ type: 'page', id, revision })
      return { ok: true, version: textVersion(text) }
    })
  }

  keepDraft(id: string, blocks: Block[]): Promise<void> {
    return this.run(() => this.history.saveDraft(id, blocks))
  }

  updateMeta(id: string, patch: PageMetaPatch): Promise<void> {
    return this.run(async () => {
      const r = this.core.record(id)
      const disk = await this.core.readCurrent(r)
      const { meta, blocks } = parsePage(disk)
      const next: PageMeta = { ...meta, id }
      if (patch.icon !== undefined)
        next.icon = patch.icon ? this.core.metaHrefToFile(r.path, patch.icon) : undefined
      if (patch.cover !== undefined)
        next.cover = patch.cover ? this.core.toFileHref(r.path, patch.cover) : undefined
      if (patch.coverPosition !== undefined) next.coverPosition = patch.coverPosition ?? undefined
      if (patch.fullWidth !== undefined) next.fullWidth = patch.fullWidth
      await this.history.writeOwn(r, disk, serializePage(next, blocks))
      if (patch.icon !== undefined) r.icon = patch.icon ?? undefined
    })
  }

  // ---------- history ----------

  checkpoint(id?: string): Promise<void> {
    return this.run(() => this.history.checkpoint(id))
  }

  listHistory(id: string): Promise<HistoryVersion[]> {
    return this.run(() => this.history.list(id))
  }

  readHistory(id: string, version: string): Promise<PageDoc> {
    return this.run(() => this.history.read(id, version))
  }

  restoreHistory(id: string, version: string): Promise<void> {
    return this.run(() => this.history.restore(id, version))
  }

  // ---------- structure changes ----------

  /**
   * New pages start with an empty title (shown as an "Untitled" placeholder), like Notion.
   * `link` adds a link to the new page at the end of its parent.
   */
  createPage(
    parentId: string | null,
    index?: number,
    content: { title: string; blocks: Block[] } = { title: '', blocks: [] },
    options: { link?: boolean } = {}
  ): Promise<PageNode> {
    return this.run(async () => {
      const core = this.core
      const parent = parentId ? core.record(parentId) : null
      const dir = parent ? childDirOf(parent.path) : ''
      await mkdir(core.abs(dir), { recursive: true })
      const { title, blocks } = content
      const stem = await core.pageStem(dir, title)
      const path = joinPath(dir, `${stem}.md`)
      const id = randomUUID()
      const meta: PageMeta = { id, extra: {}, ...(stem !== title ? { title } : {}) }
      const fileBlocks = core.toFileBlocks(path, blocks)
      await core.writeText(path, serializePage(meta, fileBlocks))
      const record: PageRecord = { id, title, path, parentId }
      core.pages.set(id, record)
      core.knownPaths.set(id, path)
      core.index.set(id, title, blocksText(fileBlocks))
      core.insertOrder(parentId, id, index)
      await core.persist()
      if (parentId && options.link) await this.editBlocks(parentId, (b) => appendSubPageLink(b, id))
      return { id, title, path, children: [] }
    })
  }

  /** Copies a page and its sub-pages next to it; links inside the copy point to the copies. */
  duplicatePage(id: string): Promise<PageNode> {
    return this.run(async () => {
      const core = this.core
      const source = core.record(id)
      const subtree = [source, ...core.descendantsOf(id)]
      const dir = dirOf(source.path)
      const title = `${source.title || 'Untitled'} (1)`
      const stem = await core.pageStem(dir, title)
      const rootPath = joinPath(dir, `${stem}.md`)
      const newIds = new Map(subtree.map((r) => [r.id, randomUUID()]))
      const copies = subtree.map((r): PageRecord & { from: PageRecord } => ({
        from: r,
        id: newIds.get(r.id)!,
        title: r === source ? title : r.title,
        icon: r.icon,
        path:
          r === source
            ? rootPath
            : childDirOf(rootPath) + r.path.slice(childDirOf(source.path).length),
        parentId: r === source ? source.parentId : newIds.get(r.parentId!)!
      }))
      for (const c of copies) {
        core.pages.set(c.id, {
          id: c.id,
          title: c.title,
          icon: c.icon,
          path: c.path,
          parentId: c.parentId
        })
        core.knownPaths.set(c.id, c.path)
      }
      const remap = (href: string): string => {
        const pageId = pageIdFromHref(href)
        const copy = pageId && newIds.get(pageId)
        return copy ? pageLinkHref(copy) : href
      }
      for (const c of copies) {
        const doc = core.toDoc(c.from.path, await core.readCurrent(c.from))
        const meta: PageMeta = {
          ...doc.meta,
          id: c.id,
          title: stemOf(c.path) === c.title ? undefined : c.title,
          icon: doc.meta.icon ? core.metaHrefToFile(c.path, doc.meta.icon) : undefined,
          cover: doc.meta.cover ? core.toFileHref(c.path, doc.meta.cover) : undefined
        }
        const blocks = mapBlockLinks(doc.blocks, remap)
        await mkdir(core.abs(dirOf(c.path)), { recursive: true })
        const fileBlocks = core.toFileBlocks(c.path, blocks)
        await core.writeText(c.path, serializePage(meta, fileBlocks))
        core.index.set(c.id, c.title, blocksText(fileBlocks))
        const order = core.state.order[c.from.id]
        if (order) core.state.order[c.id] = order.map((child) => newIds.get(child) ?? child)
      }
      const siblings = core.childrenOf(source.parentId).filter((r) => r.id !== copies[0].id)
      core.insertOrder(source.parentId, copies[0].id, siblings.indexOf(source) + 1)
      await core.persist()
      if (source.parentId) {
        await this.editBlocks(source.parentId, (b) => insertSubPageLinkAfter(b, id, copies[0].id))
      }
      return this.nodeOf(copies[0].id)
    })
  }

  private nodeOf(id: string): PageNode {
    const find = (nodes: PageNode[]): PageNode | null => {
      for (const n of nodes) {
        if (n.id === id) return n
        const hit = find(n.children)
        if (hit) return hit
      }
      return null
    }
    return find(this.tree())!
  }

  renamePage(id: string, title: string): Promise<void> {
    return this.run(async () => {
      const r = this.core.record(id)
      const dir = dirOf(r.path)
      const stem = await this.core.pageStem(dir, title, stemOf(r.path))
      await this.links.relocate(r, dir, stem)
      r.title = title
      this.core.index.setTitle(id, title)
      await this.links.syncTitleField(r)
    })
  }

  movePage(id: string, newParentId: string | null, index: number): Promise<void> {
    return this.run(async () => {
      const core = this.core
      const r = core.record(id)
      if (
        newParentId === id ||
        (newParentId && core.descendantsOf(id).some((d) => d.id === newParentId))
      ) {
        throw new Error('A page cannot be moved inside itself')
      }
      core.removeOrder(r.parentId, id)
      const oldParentId = r.parentId
      if (newParentId !== oldParentId) {
        const parent = newParentId ? core.record(newParentId) : null
        const dir = parent ? childDirOf(parent.path) : ''
        await mkdir(core.abs(dir), { recursive: true })
        const oldDir = dirOf(r.path)
        const stem = await core.pageStem(dir, r.title)
        await this.links.relocate(r, dir, stem)
        r.parentId = newParentId
        await this.links.syncTitleField(r)
        await removeDirIfEmpty(core.abs(oldDir))
      }
      core.insertOrder(newParentId, id, index)
      await core.persist()
      if (newParentId === oldParentId) return
      if (oldParentId) await this.editBlocks(oldParentId, (b) => removeSubPageLinks(b, id))
      if (newParentId) await this.editBlocks(newParentId, (b) => appendSubPageLink(b, id))
    })
  }

  /** Changes a page's blocks for the app; open editors reload it. `edit` returns null for no change. */
  private async editBlocks(id: string, edit: (blocks: Block[]) => Block[] | null): Promise<void> {
    const core = this.core
    const r = core.record(id)
    const disk = await core.readCurrent(r)
    const blocks = edit(core.toDoc(r.path, disk).blocks)
    if (!blocks) return
    const fileBlocks = core.toFileBlocks(r.path, blocks)
    await this.history.rewrite(r, disk, serializePage({ ...parsePage(disk).meta, id }, fileBlocks))
    core.index.set(id, r.title, blocksText(fileBlocks))
    const revision = core.revision(id) + 1
    core.revisions.set(id, revision)
    core.emit({ type: 'page', id, revision })
  }

  /** Queued, so a rename or move still in flight lands first. */
  pageFile(id: string): Promise<string> {
    return this.run(async () => this.core.abs(this.core.record(id).path))
  }

  // ---------- trash ----------

  trashPage(id: string): Promise<void> {
    return this.run(() => this.trash.trash(id))
  }

  listTrash(): Promise<TrashItem[]> {
    return this.run(() => this.trash.list())
  }

  readTrash(entry: string): Promise<PageDoc> {
    return this.run(() => this.trash.read(entry))
  }

  restoreTrash(entry: string): Promise<string> {
    return this.run(() => this.trash.restore(entry))
  }

  deleteTrash(entry: string): Promise<void> {
    return this.run(() => this.trash.delete(entry))
  }

  setFavorite(id: string, favorite: boolean): Promise<void> {
    return this.run(async () => {
      this.core.record(id)
      const rest = this.core.state.favorites.filter((f) => f !== id)
      this.core.state.favorites = favorite ? [...rest, id] : rest
      await this.core.persist()
    })
  }

  // ---------- import ----------

  /** Pages imported from Notion, by the Notion id in their frontmatter. */
  findNotionPages(notionIds: string[]): Record<string, string> {
    const wanted = new Set(notionIds)
    const found: Record<string, string> = {}
    for (const r of this.core.pages.values()) {
      const { data } = splitFrontmatter(this.core.texts.get(r.path) ?? '')
      const id = data?.notionId
      // YAML quotes an id that would otherwise read as a number, so only strings are ids.
      if (typeof id === 'string' && wanted.has(id)) found[id] = r.id
    }
    return found
  }

  /** A folder for an import to stage its pages and files in, until it lands or is discarded. */
  createImportStaging(): Promise<string> {
    return this.imports.createStaging()
  }

  discardImport(staging: string): Promise<void> {
    return this.imports.discard(staging)
  }

  /** Adds a staged import as a new top-level page, then deletes its staging folder. */
  landImport(manifest: ImportManifest, staging: string): Promise<ImportResult> {
    return this.run(async () => {
      try {
        return await this.imports.land(manifest, staging)
      } finally {
        this.core.emit({ type: 'tree' })
        await this.imports.discard(staging)
      }
    })
  }

  /** Saves bytes under attachments/ and returns the internal href for them. */
  saveAttachment(name: string, data: Uint8Array): Promise<string> {
    return this.run(async () => {
      const dir = this.core.abs(ATTACHMENTS_DIR)
      await mkdir(dir, { recursive: true })
      const ext = name.toLowerCase().endsWith(DRAWING_SUFFIX)
        ? name.slice(-DRAWING_SUFFIX.length)
        : extname(name)
      const base = sanitizeTitle(basename(name, ext)) || 'file'
      const stem = await uniqueName(dir, base, ext)
      await writeFileAtomic(join(dir, stem + ext), data)
      return '/' + encodeHref(`${ATTACHMENTS_DIR}/${stem}${ext}`)
    })
  }

  /** The text of a drawing file, or null when there is none at that href. */
  async readDrawing(internalHref: string): Promise<string | null> {
    const file = isDrawingHref(internalHref) ? this.resolveAsset(internalHref) : null
    if (!file) return null
    return readFile(file, 'utf8').catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null
      throw err
    })
  }

  /** Absolute path for an internal `/…` href, refusing anything outside the workspace. */
  resolveAsset(internalHref: string): string | null {
    const rel = joinPath(decodeHref(internalHref))
    if (rel === '' || rel.startsWith(APP_DIR)) return null
    return this.core.abs(rel)
  }
}

function textVersion(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}
