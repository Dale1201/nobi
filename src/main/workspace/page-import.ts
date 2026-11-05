import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rename, rm, unlink } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import type { Block, Inline } from '../../shared/core/blocks'
import { mapBlockLinks, pageLinkHref } from '../../shared/core/links'
import { serializePage, type PageMeta } from '../../shared/core/page'
import { childDirOf, encodeHref, joinPath, sanitizeTitle, stemOf } from '../../shared/core/paths'
import { blocksText } from '../../shared/core/text'
import { ISSUE_KINDS, type IssueKind } from '../../shared/notion/types'
import type { ImportResult } from '../../shared/types'
import { STAGED_FILE_PREFIX, type ImportManifest, type StagedPage } from '../import/types'
import { ATTACHMENTS_DIR, type PageRecord, type WorkspaceCore } from './core'
import { uniqueName, writeFileAtomic } from './fs-utils'
import { APP_DIR } from './state'

export const IMPORT_TITLE = 'Imported from Notion'
export const REPORT_TITLE = 'Import report'
const STAGING_PREFIX = 'import-'
const WRITE_CONCURRENCY = 16

/** Staging folders for imports, inside the workspace so landing is a rename. */
export class PageImports {
  private readonly active = new Set<string>()

  constructor(private readonly core: WorkspaceCore) {}

  async createStaging(): Promise<string> {
    const dir = join(
      this.core.root,
      APP_DIR,
      `${STAGING_PREFIX}${Date.now()}-${randomUUID().slice(0, 8)}`
    )
    this.active.add(dir)
    await mkdir(dir, { recursive: true })
    return dir
  }

  async discard(staging: string): Promise<void> {
    this.active.delete(staging)
    await rm(staging, { recursive: true, force: true })
  }

  /** Removes staging left by an import that was interrupted by a crash or quit. */
  async removeStale(): Promise<void> {
    const dir = join(this.core.root, APP_DIR)
    const names = await readdir(dir).catch(() => [] as string[])
    for (const name of names) {
      const path = join(dir, name)
      if (name.startsWith(STAGING_PREFIX) && !this.active.has(path)) {
        await rm(path, { recursive: true, force: true })
      }
    }
  }

  /** Moves a staged import into the workspace under a new top-level page. */
  async land(manifest: ImportManifest, staging: string): Promise<ImportResult> {
    const core = this.core
    const rootId = randomUUID()
    const reportId = randomUUID()
    const rootStem = await core.pageStem('', IMPORT_TITLE)
    const rootPath = `${rootStem}.md`
    const top = manifest.pages.filter((p) => p.parentId === null)
    const all: StagedPage[] = [
      {
        id: rootId,
        parentId: null,
        title: rootStem,
        blocks: [...top, { id: reportId }].map((p) => pageLinkBlock(p.id))
      },
      ...manifest.pages.map((p) => ({ ...p, parentId: p.parentId ?? rootId })),
      {
        id: reportId,
        parentId: rootId,
        title: REPORT_TITLE,
        blocks: reportBlocks(manifest, core.now())
      }
    ]

    const paths = new Map<string, string>([[rootId, rootPath]])
    const taken = new Map<string, Set<string>>()
    for (const page of all.slice(1)) {
      const dir = childDirOf(paths.get(page.parentId!)!)
      const names = taken.get(dir) ?? new Set<string>()
      taken.set(dir, names)
      const stem = uniqueStem(names, sanitizeTitle(page.title).normalize('NFC'))
      paths.set(page.id, joinPath(dir, `${stem}.md`))
    }

    // Pages are written under staging and moved in by renames; a failure before the last rename is undone.
    const out = join(staging, 'out')
    const undo: Array<() => Promise<void>> = []
    const texts = new Map<string, string>()
    const indexed = new Map<string, string>()
    const icons = new Map<string, string>()
    try {
      const fileHrefs = await this.moveFiles(manifest, undo)
      const remap = (href: string): string =>
        href.startsWith(STAGED_FILE_PREFIX)
          ? (fileHrefs.get(href.slice(STAGED_FILE_PREFIX.length)) ?? '')
          : href
      for (const [id, path] of paths) core.knownPaths.set(id, path)

      const files: Array<[string, string]> = []
      for (const page of all) {
        const path = paths.get(page.id)!
        const blocks = mapBlockLinks(page.blocks, remap)
        const meta: PageMeta = {
          id: page.id,
          extra: page.notionId ? { notionId: page.notionId } : {},
          ...(stemOf(path) !== page.title ? { title: page.title } : {})
        }
        const icon = page.icon && remap(page.icon)
        if (icon) {
          meta.icon = core.metaHrefToFile(path, icon)
          icons.set(page.id, icon)
        }
        const cover = page.cover && remap(page.cover)
        if (cover) meta.cover = core.toFileHref(path, cover)
        const text = serializePage(meta, core.toFileBlocks(path, blocks))
        texts.set(page.id, text)
        if (page.id !== rootId) indexed.set(page.id, blocksText(blocks))
        files.push([join(out, ...path.split('/')), text])
      }
      // Each write waits on its own fsync, so one at a time is slow on a busy disk.
      await inPool(files, WRITE_CONCURRENCY, async ([file, text]) => {
        await mkdir(dirname(file), { recursive: true })
        await writeFileAtomic(file, text)
      })
      await rename(join(out, rootStem), core.abs(rootStem))
      undo.push(() => rename(core.abs(rootStem), join(out, rootStem)))
      await rename(join(out, rootPath), core.abs(rootPath))
    } catch (err) {
      for (const step of undo.reverse()) await step().catch(() => {})
      for (const id of paths.keys()) core.knownPaths.delete(id)
      throw err
    }

    for (const page of all) {
      const path = paths.get(page.id)!
      const icon = icons.get(page.id)
      const record: PageRecord = {
        id: page.id,
        title: page.title,
        path,
        parentId: page.parentId,
        ...(icon ? { icon } : {})
      }
      core.pages.set(page.id, record)
      core.remember(path, texts.get(page.id)!)
      core.index.set(page.id, page.title, indexed.get(page.id) ?? '')
      if (page.parentId) (core.state.order[page.parentId] ??= []).push(page.id)
    }
    core.insertOrder(null, rootId)
    // The pages are in; without the saved order, siblings sort by name after a restart.
    await core.persist().catch((err: unknown) => {
      console.error('Could not save the workspace state after an import', err)
    })
    return {
      rootId,
      reportId,
      pages: manifest.pages.length,
      issues: uniqueIssues(manifest).length
    }
  }

  /** Gives each staged file its final name in attachments/; returns key -> internal href. */
  private async moveFiles(
    manifest: ImportManifest,
    undo: Array<() => Promise<void>>
  ): Promise<Map<string, string>> {
    const dir = this.core.abs(ATTACHMENTS_DIR)
    await mkdir(dir, { recursive: true })
    const hrefs = new Map<string, string>()
    for (const file of manifest.files) {
      const from = file.path
      if (!from) {
        hrefs.set(file.key, file.url ?? '')
        continue
      }
      const raw = extname(file.name)
      const ext = /^\.[a-z0-9]{1,8}$/i.test(raw) ? raw.toLowerCase() : ''
      const stemName = sanitizeTitle(ext ? basename(file.name, raw) : file.name) || 'file'
      const stem = await uniqueName(dir, stemName, ext)
      const dest = join(dir, stem + ext)
      await rename(from, dest)
      undo.push(() => rename(dest, from).catch(() => unlink(dest)))
      hrefs.set(file.key, '/' + encodeHref(`${ATTACHMENTS_DIR}/${stem}${ext}`))
    }
    return hrefs
  }
}

/** A name is taken if it is a file or a folder: a page's file and its children's folder share a stem. */
function uniqueStem(taken: Set<string>, stem: string): string {
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? stem : `${stem} (${n})`
    const keys = [nameKey(candidate), nameKey(`${candidate}.md`)]
    if (keys.some((k) => taken.has(k))) continue
    for (const k of keys) taken.add(k)
    return candidate
  }
}

// macOS compares names without regard to case and Unicode form, so siblings must too.
const nameKey = (name: string): string => name.normalize('NFC').toLowerCase()

function pageLinkBlock(id: string): Block {
  return { type: 'pageLink', props: { href: pageLinkHref(id) }, children: [] }
}

function text(value: string): Inline {
  return { type: 'text', text: value, styles: {} }
}

function uniqueIssues(manifest: ImportManifest): ImportManifest['issues'] {
  const seen = new Set<string>()
  return manifest.issues.filter((i) => {
    const key = `${i.kind}\n${i.pageId}\n${i.detail}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function reportBlocks(manifest: ImportManifest, now: Date): Block[] {
  const issues = uniqueIssues(manifest)
  const seconds = Math.max(1, Math.round((now.getTime() - manifest.startedAt) / 1000))
  const sources = manifest.sources.map((s) => basename(s)).join(', ')
  const when = now.toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short' })
  const pages = manifest.pages.length
  const files = manifest.files.filter((f) => f.path).length
  const blocks: Block[] = [
    {
      type: 'paragraph',
      props: {},
      content: [
        text(
          `Imported ${pages} ${pages === 1 ? 'page' : 'pages'} and ${files} ${files === 1 ? 'file' : 'files'} ` +
            `from ${sources} on ${when}, in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.`
        )
      ],
      children: []
    }
  ]
  if (issues.length === 0) {
    blocks.push({
      type: 'paragraph',
      props: {},
      content: [text('Everything was converted exactly.')],
      children: []
    })
    return blocks
  }
  const titles = new Map(manifest.pages.map((p) => [p.id, p.title || 'Untitled']))
  for (const kind of Object.keys(ISSUE_KINDS) as IssueKind[]) {
    const ofKind = issues.filter((i) => i.kind === kind)
    if (ofKind.length === 0) continue
    blocks.push({
      type: 'heading',
      props: { level: 2 },
      content: [text(`${ISSUE_KINDS[kind]} (${ofKind.length})`)],
      children: []
    })
    for (const issue of ofKind) {
      const title = titles.get(issue.pageId)
      blocks.push({
        type: 'bulletListItem',
        props: {},
        content: title
          ? [
              { type: 'link', href: pageLinkHref(issue.pageId), content: [text(title)] } as Inline,
              text(`: ${issue.detail}`)
            ]
          : [text(issue.detail)],
        children: []
      })
    }
  }
  return blocks
}

/** Runs `work` on at most `size` items at a time; a failure stops the rest once those running end. */
async function inPool<T>(
  items: T[],
  size: number,
  work: (item: T) => Promise<void>
): Promise<void> {
  let next = 0
  let failed = false
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      await work(items[next++]).catch((err: unknown) => {
        failed = true
        throw err
      })
    }
  }
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(size, items.length) }, worker)
  )
  const rejected = results.find((r) => r.status === 'rejected')
  if (rejected) throw rejected.reason
}
