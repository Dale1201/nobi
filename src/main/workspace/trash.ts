import { mkdir, readFile, readdir, rename, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { metaFromData, splitFrontmatter } from '../../shared/core/page'
import { childDirOf } from '../../shared/core/paths'
import type { LinkPlace } from '../../shared/core/subpages'
import { exists, writeFileAtomic } from './fs-utils'
import { APP_DIR } from './state'

export interface TrashMeta {
  id: string
  title: string
  originalPath: string
  parentId: string | null
  deletedAt: string
  /** Position among its siblings, so a restore puts it back in place. */
  index?: number
  /** Ids of the pages in the entry that were in Favorites. */
  favorites?: string[]
  /** Workspace path of each page the trashed pages link to -> its id, as of the delete. */
  links?: Record<string, string>
  /** Where the parent linked to the page, so a restore puts the link back in place. */
  linkAt?: LinkPlace
}

/** One deleted page (with its sub-pages) as stored in `.nobi/trash/<entry>/`. */
export interface TrashEntry {
  entry: string
  meta: TrashMeta
  /** Absolute path of the page file inside the entry. */
  file: string
  /** Absolute path of the page's child folder inside the entry (may not exist). */
  folder: string
}

const DAY_MS = 24 * 60 * 60 * 1000
export const TRASH_RETENTION_DAYS = 30

export class Trash {
  constructor(
    private readonly root: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  private base(): string {
    return join(this.root, APP_DIR, 'trash')
  }

  /** Moves a page file and its child folder into a new entry. */
  async add(meta: Omit<TrashMeta, 'deletedAt'>): Promise<string> {
    const deletedAt = this.now()
    const entry = `${deletedAt.toISOString().replace(/[:.]/g, '-')}-${meta.id}`
    const dest = join(this.base(), entry)
    await mkdir(dest, { recursive: true })
    // Written first: an entry whose page never arrived is recognisable and cleaned up by list().
    const full: TrashMeta = { ...meta, deletedAt: deletedAt.toISOString() }
    await writeFileAtomic(join(dest, 'meta.json'), JSON.stringify(full, null, 2) + '\n')
    const name = basename(meta.originalPath)
    await rename(join(this.root, ...meta.originalPath.split('/')), join(dest, name))
    const folder = join(this.root, ...childDirOf(meta.originalPath).split('/'))
    if (await exists(folder)) await rename(folder, join(dest, name.slice(0, -3)))
    return entry
  }

  /** Newest first; unreadable entries are skipped, and empty ones left by an interrupted delete removed. */
  async list(): Promise<TrashEntry[]> {
    const names = await readdir(this.base()).catch(() => [] as string[])
    const entries: TrashEntry[] = []
    for (const name of names) {
      const entry = await this.get(name).catch(() => null)
      if (!entry) continue
      if ((await exists(entry.file)) || (await exists(entry.folder))) entries.push(entry)
      else await this.remove(entry)
    }
    return entries.sort((a, b) => b.meta.deletedAt.localeCompare(a.meta.deletedAt))
  }

  async get(entry: string): Promise<TrashEntry> {
    if (!/^[\w-]+$/.test(entry)) throw new Error(`Unknown trash item ${entry}`)
    const dir = join(this.base(), entry)
    const meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as TrashMeta
    const name = basename(meta.originalPath)
    return { entry, meta, file: join(dir, name), folder: join(dir, name.slice(0, -3)) }
  }

  /** Ids of the page and every sub-page in an entry, read from their frontmatter. */
  async pageIds(entry: TrashEntry): Promise<string[]> {
    const ids = [entry.meta.id]
    const walk = async (dir: string): Promise<void> => {
      const items = await readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const item of items) {
        const path = join(dir, item.name)
        if (item.isDirectory()) await walk(path)
        else if (item.name.toLowerCase().endsWith('.md')) {
          const { data } = splitFrontmatter(await readFile(path, 'utf8'))
          const id = data ? metaFromData(data).id : undefined
          if (id && !ids.includes(id)) ids.push(id)
        }
      }
    }
    await walk(entry.folder)
    return ids
  }

  async countPages(entry: TrashEntry): Promise<number> {
    let count = 1
    const walk = async (dir: string): Promise<void> => {
      const items = await readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const item of items) {
        if (item.isDirectory()) await walk(join(dir, item.name))
        else if (item.name.toLowerCase().endsWith('.md')) count++
      }
    }
    await walk(entry.folder)
    return count
  }

  async remove(entry: TrashEntry): Promise<void> {
    await rm(join(this.base(), entry.entry), { recursive: true, force: true })
  }

  /** Entries deleted more than 30 days ago. */
  async expired(): Promise<TrashEntry[]> {
    const cutoff = this.now().getTime() - TRASH_RETENTION_DAYS * DAY_MS
    return (await this.list()).filter((e) => new Date(e.meta.deletedAt).getTime() < cutoff)
  }
}
