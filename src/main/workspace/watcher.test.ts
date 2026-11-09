import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Block } from '../../shared/core/blocks'
import { writeFileAtomic } from './fs-utils'
import { isIgnored, watchWorkspace, type WorkspaceWatcher } from './watcher'
import { Workspace, type WorkspaceEvent } from './workspace'

let root: string
let watcher: WorkspaceWatcher | null

beforeEach(async () => {
  // tmpdir() is under /var, a symlink to /private/var, like a workspace reached through a link.
  root = await mkdtemp(join(tmpdir(), 'nobi-watch-'))
  watcher = null
})
afterEach(async () => {
  await watcher?.close()
  await rm(root, { recursive: true, force: true })
})

/** Saves like most editors, so the workspace (with no settle delay) never reads a half-written file. */
const writeOutside = (rel: string, body: string): Promise<void> =>
  writeFileAtomic(join(root, rel), body)
const text = (t: string): Block => ({
  type: 'paragraph',
  props: {},
  content: [{ type: 'text', text: t, styles: {} }],
  children: []
})

/** A workspace wired to a real watcher, recording the events it emits. */
async function watched(): Promise<{
  ws: Workspace
  events: WorkspaceEvent[]
  next: (match: (e: WorkspaceEvent) => boolean) => Promise<void>
}> {
  const ws = await Workspace.open(root, { settleMs: 0 })
  const events: WorkspaceEvent[] = []
  const waiters: { match: (e: WorkspaceEvent) => boolean; resolve: () => void }[] = []
  ws.onEvent((e) => {
    events.push(e)
    for (const w of waiters.filter((w) => w.match(e))) {
      waiters.splice(waiters.indexOf(w), 1)
      w.resolve()
    }
  })
  watcher = watchWorkspace(
    root,
    (changes) => void ws.reconcile(changes),
    (err) => {
      throw err
    }
  )
  await watcher.ready
  const next = (match: (e: WorkspaceEvent) => boolean): Promise<void> =>
    new Promise((resolve) => waiters.push({ match, resolve }))
  return { ws, events, next }
}

describe('watchWorkspace', () => {
  it('reports an outside edit to the open workspace', async () => {
    const { ws, next } = await watched()
    const { id, path } = await ws.createPage(null)
    const changed = next((e) => e.type === 'page' && e.id === id)
    await writeOutside(path, `---\nid: ${id}\n---\n\nFrom another editor\n`)
    await changed
    expect((await ws.readPage(id)).blocks).toEqual([text('From another editor')])
  })

  it('stays quiet about the app’s own writes', async () => {
    const { ws, events, next } = await watched()
    const { id } = await ws.createPage(null)
    await ws.writePage(id, [text('typed in the app')])
    await ws.renamePage(id, 'Renamed')
    await ws.setFavorite(id, true)
    // An outside file added afterwards proves earlier events were already processed.
    const marker = next((e) => e.type === 'tree')
    await writeOutside('Marker.md', 'marker\n')
    await marker
    expect(events).toEqual([{ type: 'tree' }])
  })
})

describe('isIgnored', () => {
  it('watches pages and the workspace state, nothing else', () => {
    expect(isIgnored('Notes.md')).toBe(false)
    expect(isIgnored('Projects/Plan.md')).toBe(false)
    expect(isIgnored('Projects')).toBe(false)
    expect(isIgnored('.nobi')).toBe(false)
    expect(isIgnored('.nobi/workspace.json')).toBe(false)
    expect(isIgnored('.nobi/history')).toBe(true)
    expect(isIgnored('.nobi/trash/x/Page.md')).toBe(true)
    expect(isIgnored('attachments')).toBe(true)
    expect(isIgnored('attachments/cat.png')).toBe(true)
    expect(isIgnored('.Notes.md.1a2b3c.tmp')).toBe(true)
    expect(isIgnored('Projects/.git/config')).toBe(true)
  })
})
