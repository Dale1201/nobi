import { readFile, readdir, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { insertId, splitFrontmatter, metaFromData } from '../../shared/core/page'
import { childDirOf, joinPath, stemOf } from '../../shared/core/paths'
import type { FileChange } from '../../shared/types'
import {
  ATTACHMENTS_DIR,
  fileStat,
  iconToInternal,
  type PageRecord,
  type WorkspaceCore
} from './core'
import { createFileAtomic, writeFileAtomic } from './fs-utils'
import { SNAPSHOT_INTERVAL_MS, type PageHistory } from './page-history'
import { APP_DIR, STATE_FILE, loadState } from './state'

/** A file modified this recently may still be being written by another program. */
export const SETTLE_MS = 1000

/** A page file found while walking the folder. */
interface FoundFile {
  path: string
  parentPath: string | null
  text: string
  stat: string
  mtime: number
  /** Creation time, so the older of two files sharing an id keeps it. */
  born: number
  dataId?: string
}

interface ScanDiff {
  added: string[]
  removed: string[]
  changed: { id: string; oldText: string | undefined; oldPath: string }[]
}

/** Keeps the page maps in step with the folder when other programs change it. */
export class ExternalChanges {
  private settleTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly core: WorkspaceCore,
    private readonly history: PageHistory,
    private readonly settleMs: number,
    private readonly run: (task: () => Promise<void>) => Promise<void>
  ) {}

  close(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer)
    this.settleTimer = null
  }

  /** Modified so recently that another program may still be writing it (mtime can lead the clock). */
  private unsettled(mtime: number): boolean {
    return this.settleMs > 0 && Math.abs(Date.now() - mtime) < this.settleMs
  }

  /** Looks at the folder again once files that were still being written have settled. */
  private rescanLater(): void {
    if (this.settleTimer) return
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null
      void this.run(() => this.rescanChanges()).catch((err) => console.error('Rescan failed', err))
    }, this.settleMs)
  }

  // ---------- scanning ----------

  /** Walks the folder and rebuilds the page maps, reusing text of files that did not change. */
  async scan(): Promise<ScanDiff> {
    const core = this.core
    const old = { pages: core.pages, texts: core.texts, stats: core.stats }
    const walked: FoundFile[] = []
    await this.walk('', null, walked)
    const oldIdAt = new Map([...old.pages.values()].map((r) => [r.path, r.id]))
    const idOf = new Map<FoundFile, string>()
    const claimed = new Set<string>()
    // A page keeps its id at its known path, so a sync tool's conflicted copy is the one renumbered,
    // and a file whose id line an editor dropped is still the same page.
    for (const f of walked) {
      const known = oldIdAt.get(f.path)
      const id = f.dataId ?? known
      if (id && id === known && !claimed.has(id)) {
        claimed.add(id)
        idOf.set(f, id)
      }
    }
    const unsettled: string[] = []
    const before = new Map<string, string>()
    for (const f of [...walked].sort((a, b) => a.born - b.born)) {
      let id = idOf.get(f)
      if (id === undefined && f.dataId && !claimed.has(f.dataId)) id = f.dataId
      if (id === undefined) id = randomUUID()
      claimed.add(id)
      idOf.set(f, id)
      if (f.dataId === id) continue
      // A file another program is still writing would be cut short by writing the id now.
      if (this.unsettled(f.mtime)) {
        unsettled.push(f.path)
        continue
      }
      // Only the id is added; the rest of the file is left exactly as the user wrote it.
      before.set(f.path, f.text)
      f.text = insertId(f.text, id)
      await writeFileAtomic(core.abs(f.path), f.text)
      f.stat = (await fileStat(core.abs(f.path))).key
    }
    // Unsettled new pages (and their sub-pages) wait; known ones keep their id in memory meanwhile.
    const waiting = unsettled.filter((path) => !oldIdAt.has(path))
    const found = walked.filter(
      (f) => !waiting.some((w) => f.path === w || f.path.startsWith(childDirOf(w) + '/'))
    )
    if (unsettled.length) this.rescanLater()

    const pages = new Map<string, PageRecord>()
    const texts = new Map<string, string>()
    const stats = new Map<string, string>()
    const idByPath = new Map(found.map((f) => [f.path, idOf.get(f)!]))
    for (const f of found) {
      const id = idOf.get(f)!
      const { data } = splitFrontmatter(f.text)
      const meta = data ? metaFromData(data) : { extra: {} }
      pages.set(id, {
        id,
        title: meta.title ?? stemOf(f.path),
        icon: iconToInternal(f.path, meta.icon),
        path: f.path,
        parentId: f.parentPath === null ? null : (idByPath.get(f.parentPath) ?? null)
      })
      texts.set(f.path, f.text)
      stats.set(f.path, f.stat)
      core.knownPaths.set(id, f.path)
    }

    const diff: ScanDiff = { added: [], removed: [], changed: [] }
    for (const [id, r] of pages) {
      const prev = old.pages.get(id)
      if (!prev) diff.added.push(id)
      else if (
        old.texts.get(prev.path) !== texts.get(r.path) &&
        old.texts.get(prev.path) !== before.get(r.path)
      ) {
        diff.changed.push({ id, oldText: old.texts.get(prev.path), oldPath: prev.path })
      }
    }
    for (const id of old.pages.keys()) if (!pages.has(id)) diff.removed.push(id)
    core.pages = pages
    core.texts = texts
    core.stats = stats
    return diff
  }

  private async walk(dir: string, parentPath: string | null, found: FoundFile[]): Promise<void> {
    const core = this.core
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(core.abs(dir), { withFileTypes: true })
    } catch {
      return
    }
    const files = new Set(
      entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md')).map((e) => e.name)
    )
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
    // A folder without a page file becomes a page so its children stay reachable.
    for (const name of dirs) {
      if (dir === '' && name === ATTACHMENTS_DIR) continue
      // macOS volumes are usually case-insensitive: "notes/" belongs to "Notes.md".
      const owned = [...files].some((f) => f.slice(0, -3).toLowerCase() === name.toLowerCase())
      const pageFile = joinPath(dir, `${name}.md`)
      if (owned) continue
      // Atomic and only if absent, so a page another program writes there meanwhile is kept whole.
      const id = randomUUID()
      const made = await createFileAtomic(core.abs(pageFile), insertId('', id))
      if (made) {
        core.stubs.set(pageFile, id)
        files.add(`${name}.md`)
      }
    }
    for (const file of [...files]) {
      const path = joinPath(dir, file)
      if (!core.stubs.has(path)) continue
      const stem = file.slice(0, -3).toLowerCase()
      if (dirs.some((d) => d.toLowerCase() === stem)) continue
      const text = await readFile(core.abs(path), 'utf8').catch(() => null)
      if (text === null || !this.isOwnStub(path, text)) {
        core.stubs.delete(path)
        continue
      }
      if (
        await unlink(core.abs(path)).then(
          () => true,
          () => false
        )
      ) {
        core.stubs.delete(path)
        files.delete(file)
      }
    }
    for (const file of [...files].sort()) {
      if (file.startsWith('.')) continue
      const path = joinPath(dir, file)
      const info = await fileStat(core.abs(path)).catch(() => null)
      if (info === null) continue
      const cached = core.stats.get(path) === info.key ? core.texts.get(path) : undefined
      const text = cached ?? (await readFile(core.abs(path), 'utf8').catch(() => null))
      if (text === null) continue
      const { data } = splitFrontmatter(text)
      found.push({
        path,
        parentPath,
        text,
        stat: info.key,
        mtime: info.mtime,
        born: info.born,
        dataId: data ? metaFromData(data).id : undefined
      })
      await this.walk(childDirOf(path), path, found)
    }
  }

  /** Still exactly what the app wrote for the folder, carrying the id it gave it. */
  private isOwnStub(path: string, text: string): boolean {
    const id = this.core.stubs.get(path)
    const { data } = splitFrontmatter(text)
    return isStubText(text) && data !== null && metaFromData(data).id === id
  }

  // ---------- external changes ----------

  /** Applies a batch of file events; the disk is the source of truth. */
  async reconcile(changes: FileChange[]): Promise<void> {
    const core = this.core
    const byPath = core.pathIndex()
    let structural = false
    let stateChanged = false
    const edited = new Set<string>()
    for (const { kind, path } of changes) {
      if (path === `${APP_DIR}/${STATE_FILE}`) stateChanged = true
      else if (kind === 'add' || kind === 'change') {
        if (!path.toLowerCase().endsWith('.md')) continue
        if (byPath.has(path)) edited.add(path)
        else structural = true
      } else if (kind === 'unlink') {
        if (byPath.has(path)) structural = true
      } else if (kind === 'addDir') {
        const ours = path === ATTACHMENTS_DIR || path === APP_DIR
        if (!ours && !byPath.has(`${path}.md`)) structural = true
      } else if ([...byPath.keys()].some((p) => p === `${path}.md` || p.startsWith(`${path}/`))) {
        structural = true
      }
    }
    if (stateChanged) await this.reloadState()
    if (structural) return this.rescanChanges()
    for (const path of edited) {
      const r = core.pages.get(byPath.get(path)!)
      const text = await readFile(core.abs(path), 'utf8').catch(() => null)
      if (r && text !== null && text !== core.texts.get(path)) await this.applyExternal(r, text)
    }
  }

  async rescanChanges(): Promise<void> {
    const core = this.core
    const before = core.pages
    const diff = await this.scan()
    for (const id of diff.added)
      core.indexText(core.pages.get(id)!, core.texts.get(core.pages.get(id)!.path)!)
    for (const id of diff.removed) {
      core.index.remove(id)
      core.owned.delete(id)
    }
    for (const r of core.pages.values()) core.index.setTitle(r.id, r.title)
    for (const { id, oldText, oldPath } of diff.changed) {
      const r = core.pages.get(id)!
      await this.contentChanged(r, oldText, oldPath)
    }
    // Watcher events can arrive after the app already applied them, so a rescan may find nothing new.
    if (!sameTree(before, core.pages)) core.emit({ type: 'tree' })
  }

  async applyExternal(r: PageRecord, text: string): Promise<void> {
    const core = this.core
    const oldText = core.texts.get(r.path)
    let current = text
    const { data } = splitFrontmatter(text)
    const meta = data ? metaFromData(data) : { extra: {} as Record<string, unknown> }
    if (data && !meta.id) {
      // An editor dropped the id line; put it back once the file is no longer being written.
      const { mtime } = await fileStat(core.abs(r.path))
      if (this.unsettled(mtime)) this.rescanLater()
      else {
        current = insertId(text, r.id)
        await writeFileAtomic(core.abs(r.path), current)
      }
    }
    core.remember(r.path, current)
    const title = meta.title ?? stemOf(r.path)
    const icon = iconToInternal(r.path, meta.icon)
    const treeChanged = title !== r.title || icon !== r.icon
    r.title = title
    r.icon = icon
    await this.contentChanged(r, oldText, r.path)
    if (treeChanged) core.emit({ type: 'tree' })
  }

  /** Keeps what the app had in history, then tells the renderer the page changed underneath it. */
  private async contentChanged(
    r: PageRecord,
    oldText: string | undefined,
    oldPath: string
  ): Promise<void> {
    const core = this.core
    // What the user wrote here is always kept; text from elsewhere at most every 10 minutes.
    const now = core.now().getTime()
    const due = now - (core.lastSnapshot.get(r.id) ?? 0) >= SNAPSHOT_INTERVAL_MS
    if (oldText !== undefined && (core.owned.has(r.id) || due)) {
      await this.history.snapshotQuietly(r.id, oldText, oldPath)
      core.lastSnapshot.set(r.id, now)
    }
    core.owned.delete(r.id)
    const revision = core.revision(r.id) + 1
    core.revisions.set(r.id, revision)
    core.indexText(r, core.texts.get(r.path) ?? '')
    core.emit({ type: 'page', id: r.id, revision })
  }

  private async reloadState(): Promise<void> {
    const core = this.core
    const text = await readFile(join(core.root, APP_DIR, STATE_FILE), 'utf8').catch(() => '')
    if (text === core.stateText) return
    core.stateText = text
    core.state = await loadState(core.root)
    core.emit({ type: 'tree' })
  }
}

function sameTree(a: Map<string, PageRecord>, b: Map<string, PageRecord>): boolean {
  if (a.size !== b.size) return false
  for (const [id, r] of a) {
    const s = b.get(id)
    if (
      !s ||
      s.title !== r.title ||
      s.icon !== r.icon ||
      s.path !== r.path ||
      s.parentId !== r.parentId
    ) {
      return false
    }
  }
  return true
}

function isStubText(text: string): boolean {
  const { data, body } = splitFrontmatter(text)
  return data !== null && body.trim() === '' && Object.keys(data).every((k) => k === 'id')
}
