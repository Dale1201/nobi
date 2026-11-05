import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  utimes,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Block } from '../../shared/core/blocks'
import { parsePage } from '../../shared/core/page'
import { blocksText } from '../../shared/core/text'
import type { FileChange } from '../../shared/types'
import { Workspace, type WorkspaceEvent } from './workspace'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nobsidian-external-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const read = (rel: string): Promise<string> => readFile(join(root, rel), 'utf8')
const write = (rel: string, body: string): Promise<void> => writeFile(join(root, rel), body)
const text = (t: string): Block => ({
  type: 'paragraph',
  props: {},
  content: [{ type: 'text', text: t, styles: {} }],
  children: []
})
const change = (path: string): FileChange => ({ kind: 'change', path })

/** Snapshot bodies of a page, newest first. */
async function bodies(id: string): Promise<string[]> {
  const dir = join(root, '.nobsidian', 'history', id)
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith('.md'))
  const texts = await Promise.all(
    names
      .sort()
      .reverse()
      .map((n) => readFile(join(dir, n), 'utf8'))
  )
  return texts.map((t) => blocksText(parsePage(t).blocks))
}

async function opened(): Promise<{ ws: Workspace; events: WorkspaceEvent[] }> {
  const ws = await Workspace.open(root, { settleMs: 0 })
  const events: WorkspaceEvent[] = []
  ws.onEvent((e) => events.push(e))
  return { ws, events }
}

async function namedPage(ws: Workspace, title: string): Promise<string> {
  const { id } = await ws.createPage(null)
  await ws.renamePage(id, title)
  return id
}

describe('Edits made outside the app', () => {
  it('ignores the app’s own writes', async () => {
    const { ws, events } = await opened()
    const id = await namedPage(ws, 'Mine')
    await ws.writePage(id, [text('typed')])
    await ws.reconcile([
      change('Mine.md'),
      { kind: 'add', path: 'Mine.md' },
      { kind: 'addDir', path: '.nobsidian' },
      { kind: 'addDir', path: 'attachments' },
      // Reported late, after the rename already moved the page away from here.
      { kind: 'add', path: 'Untitled.md' },
      change('Untitled.md'),
      { kind: 'unlink', path: 'Untitled.md' }
    ])
    expect(events).toEqual([])
  })

  it('picks up an outside edit: new revision, search, and title from frontmatter', async () => {
    const { ws, events } = await opened()
    const id = await namedPage(ws, 'Note')
    await write('Note.md', `---\nid: ${id}\ntitle: Better title\n---\n\nFresh words\n`)
    await ws.reconcile([change('Note.md')])
    expect(events).toEqual([{ type: 'page', id, revision: 1 }, { type: 'tree' }])
    expect(ws.tree()[0].title).toBe('Better title')
    expect((await ws.search('fresh')).map((h) => h.id)).toEqual([id])
    const doc = await ws.readPage(id)
    expect(doc).toMatchObject({ revision: 1, blocks: [text('Fresh words')] })
  })

  it('saves what the app wrote to history before an outside edit replaces it', async () => {
    const { ws } = await opened()
    const id = await namedPage(ws, 'Note')
    await ws.writePage(id, [text('my draft')])
    await write('Note.md', `---\nid: ${id}\n---\n\nTheirs\n`)
    await ws.reconcile([change('Note.md')])
    expect((await bodies(id))[0]).toBe('my draft')
  })

  it('keeps text another app wrote before a newer outside edit replaces it, every 10 minutes', async () => {
    let clock = new Date('2026-10-21T10:00:00.000Z')
    await write('Log.md', 'one\n')
    const ws = await Workspace.open(root, { now: () => clock, settleMs: 0 })
    const id = ws.tree()[0].id
    const head = /^---\n[\s\S]*?\n---\n/.exec(await read('Log.md'))![0]
    const edit = async (body: string): Promise<void> => {
      await write('Log.md', `${head}\n${body}\n`)
      await ws.reconcile([change('Log.md')])
    }
    await edit('two')
    clock = new Date('2026-10-21T10:05:00.000Z')
    await edit('three')
    clock = new Date('2026-10-21T10:11:00.000Z')
    await edit('four')
    expect(await bodies(id)).toEqual(['three', 'one'])
  })

  it('refuses a save from an editor that has not seen the outside edit, unless forced', async () => {
    const { ws } = await opened()
    const id = await namedPage(ws, 'Note')
    await ws.writePage(id, [text('v1')], { revision: 0 })
    await write('Note.md', `---\nid: ${id}\n---\n\nTheirs\n`)
    // No watcher event yet: the save itself must notice the file changed.
    expect(await ws.writePage(id, [text('stale')], { revision: 0 })).toEqual({
      ok: false,
      reason: 'conflict'
    })
    expect(await read('Note.md')).toContain('Theirs')
    expect(await ws.writePage(id, [text('mine')], { revision: 0, force: true })).toEqual({
      ok: true,
      revision: 1
    })
    expect(await read('Note.md')).toContain('mine')
    expect((await bodies(id))[0]).toBe('Theirs')
    expect(await ws.writePage(id, [text('next')], { revision: 1 })).toEqual({
      ok: true,
      revision: 1
    })
  })

  it('notices an outside edit when the page is read', async () => {
    const { ws, events } = await opened()
    const id = await namedPage(ws, 'Note')
    await write('Note.md', `---\nid: ${id}\n---\n\nTheirs\n`)
    expect((await ws.readPage(id)).revision).toBe(1)
    expect(events).toEqual([{ type: 'page', id, revision: 1 }])
  })

  it('puts back an id an outside editor dropped', async () => {
    const { ws } = await opened()
    const id = await namedPage(ws, 'Note')
    await write('Note.md', '---\ntags: [a]\n---\nNo id here\n')
    await ws.reconcile([change('Note.md')])
    expect(await read('Note.md')).toBe(`---\ntags: [a]\nid: ${id}\n---\nNo id here\n`)
  })

  it('waits until a file another program is writing has settled before adding its id', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      await write('Copying.md', 'first half')
      const ws = await Workspace.open(root, { settleMs: 60_000 })
      expect(ws.tree()).toEqual([])
      expect(await read('Copying.md')).toBe('first half')
      await write('Copying.md', 'first half, second half\n')
      const past = new Date(Date.now() - 120_000)
      await utimes(join(root, 'Copying.md'), past, past)
      await vi.advanceTimersByTimeAsync(60_000)
      await vi.waitFor(() => expect(ws.tree().map((n) => n.title)).toEqual(['Copying']))
      expect(await read('Copying.md')).toMatch(
        /^---\nid: [0-9a-f-]{36}\n---\n\nfirst half, second half\n$/
      )
      ws.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('restores a dropped id line on the same page, without calling that an outside change', async () => {
    const ws = await Workspace.open(root, { settleMs: 100 })
    const id = await namedPage(ws, 'Note')
    await ws.setFavorite(id, true)
    const before = (await ws.readPage(id)).revision
    await write('Note.md', 'Rewritten without frontmatter\n')
    await ws.reconcile([change('Note.md'), { kind: 'add', path: 'Other.md' }])
    expect(ws.tree()[0].id).toBe(id)
    expect(ws.favorites()).toEqual([id])
    // The unsettled file is rescanned later; the revision moves once the restored text is taken in.
    await vi.waitFor(
      async () => {
        expect(await read('Note.md')).toBe(`---\nid: ${id}\n---\n\nRewritten without frontmatter\n`)
        expect((await ws.readPage(id)).revision).toBe(before + 1)
      },
      { timeout: 5000 }
    )
    const doc = await ws.readPage(id)
    expect(await ws.writePage(id, [text('mine')], { revision: doc.revision })).toMatchObject({
      ok: true
    })
    ws.close()
  })

  it('shows a file whose modification time is ahead of the clock right away', async () => {
    const file = join(root, 'Future.md')
    await write('Future.md', 'From a skewed clock\n')
    const ahead = new Date(Date.now() + 3600_000)
    await utimes(file, ahead, ahead)
    const ws = await Workspace.open(root, { settleMs: 100 })
    try {
      expect(ws.tree().map((n) => n.title)).toEqual(['Future'])
      expect(await read('Future.md')).toMatch(/^---\nid: [0-9a-f-]{36}\n---\n/)
    } finally {
      ws.close()
    }
  })

  it('shows a folder and its pages at once, without waiting for the page the app made for it', async () => {
    await mkdir(join(root, 'Folder'))
    await write('Folder/Child.md', '---\nid: child-1\n---\n\nHi\n')
    const past = new Date(Date.now() - 3600_000)
    await utimes(join(root, 'Folder', 'Child.md'), past, past)
    const ws = await Workspace.open(root, { settleMs: 100 })
    try {
      expect(ws.tree().map((n) => [n.title, n.children.length])).toEqual([['Folder', 1]])
    } finally {
      ws.close()
    }
  })

  it('drops the page made for a Finder "New Folder" once the folder is renamed', async () => {
    await write('Anchor.md', 'anchor\n')
    const { ws } = await opened()
    await mkdir(join(root, 'untitled folder'))
    await ws.reconcile([{ kind: 'addDir', path: 'untitled folder' }])
    expect(ws.tree().map((n) => n.title)).toEqual(['Anchor', 'untitled folder'])
    await rename(join(root, 'untitled folder'), join(root, 'Ideas'))
    await ws.reconcile([
      { kind: 'unlinkDir', path: 'untitled folder' },
      { kind: 'addDir', path: 'Ideas' }
    ])
    expect(ws.tree().map((n) => n.title)).toEqual(['Anchor', 'Ideas'])
    expect((await readdir(root)).filter((n) => n !== '.nobsidian').sort()).toEqual([
      'Anchor.md',
      'Ideas',
      'Ideas.md'
    ])
  })

  it('keeps a folder page the user wrote in once its folder is renamed', async () => {
    await write('Anchor.md', 'anchor\n')
    const { ws } = await opened()
    await mkdir(join(root, 'untitled folder'))
    await ws.reconcile([{ kind: 'addDir', path: 'untitled folder' }])
    const stub = ws.tree().find((n) => n.title === 'untitled folder')!
    await ws.writePage(stub.id, [text('Notes')])
    await rename(join(root, 'untitled folder'), join(root, 'Ideas'))
    await ws.reconcile([
      { kind: 'unlinkDir', path: 'untitled folder' },
      { kind: 'addDir', path: 'Ideas' }
    ])
    expect(ws.tree().map((n) => n.id)).toContain(stub.id)
    expect(await read('untitled folder.md')).toContain('Notes')
  })

  it('never deletes a later page that lands at a trashed stub’s path', async () => {
    await write('Anchor.md', 'anchor\n')
    const { ws } = await opened()
    await mkdir(join(root, 'untitled folder'))
    await ws.reconcile([{ kind: 'addDir', path: 'untitled folder' }])
    const stub = ws.tree().find((n) => n.title === 'untitled folder')!
    await ws.trashPage(stub.id)
    const fresh = await ws.createPage(null)
    await ws.renamePage(fresh.id, 'untitled folder')
    await write('Other.md', 'other\n')
    await ws.reconcile([{ kind: 'add', path: 'Other.md' }])
    expect(await read('untitled folder.md')).toContain(`id: ${fresh.id}`)
    expect(ws.tree().map((n) => n.id)).toContain(fresh.id)
  })

  it('keeps a stub that another program rewrote with a different id', async () => {
    await write('Anchor.md', 'anchor\n')
    const { ws } = await opened()
    await mkdir(join(root, 'untitled folder'))
    await ws.reconcile([{ kind: 'addDir', path: 'untitled folder' }])
    await write('untitled folder.md', '---\nid: 22222222-2222-4222-8222-222222222222\n---\n')
    await ws.reconcile([change('untitled folder.md')])
    await rename(join(root, 'untitled folder'), join(root, 'Ideas'))
    await ws.reconcile([
      { kind: 'unlinkDir', path: 'untitled folder' },
      { kind: 'addDir', path: 'Ideas' }
    ])
    expect(await read('untitled folder.md')).toContain('22222222')
  })

  it('adds, moves and removes pages changed in Finder, keeping ids and favorites', async () => {
    const { ws, events } = await opened()
    const id = await namedPage(ws, 'Keep')
    await ws.setFavorite(id, true)
    await namedPage(ws, 'Gone')
    await write('Arrived.md', 'Hello from outside\n')
    await mkdir(join(root, 'Folder'))
    await rename(join(root, 'Keep.md'), join(root, 'Folder', 'Moved.md'))
    await unlink(join(root, 'Gone.md'))
    await ws.reconcile([
      { kind: 'add', path: 'Arrived.md' },
      { kind: 'addDir', path: 'Folder' },
      { kind: 'unlink', path: 'Keep.md' },
      { kind: 'add', path: 'Folder/Moved.md' },
      { kind: 'unlink', path: 'Gone.md' }
    ])
    const tree = ws.tree()
    expect(tree.map((n) => n.title)).toEqual(['Arrived', 'Folder'])
    expect(tree[1].children.map((n) => [n.id, n.title])).toEqual([[id, 'Moved']])
    expect(ws.favorites()).toEqual([id])
    expect(await read('Arrived.md')).toMatch(
      /^---\nid: [0-9a-f-]{36}\n---\n\nHello from outside\n$/
    )
    expect((await ws.search('hello')).map((h) => h.id)).toEqual([tree[0].id])
    expect(await ws.search('gone')).toEqual([])
    expect(events.at(-1)).toEqual({ type: 'tree' })
  })

  it('gives a sync tool’s conflicted copy a fresh id and keeps the original’s', async () => {
    const { ws } = await opened()
    const id = await namedPage(ws, 'Plan')
    const body = await read('Plan.md')
    await write('Plan (conflicted copy).md', body)
    await ws.reconcile([{ kind: 'add', path: 'Plan (conflicted copy).md' }])
    const byTitle = Object.fromEntries(ws.tree().map((n) => [n.title, n.id]))
    expect(byTitle['Plan']).toBe(id)
    expect(byTitle['Plan (conflicted copy)']).not.toBe(id)
    expect(await read('Plan (conflicted copy).md')).toContain(
      `id: ${byTitle['Plan (conflicted copy)']}`
    )
  })

  it('on opening, gives a conflicted copy a fresh id rather than the older original', async () => {
    const same = '---\nid: 11111111-1111-4111-8111-111111111111\n---\n\nPlan\n'
    await write('Plan (conflicted copy).md', same)
    await write('Plan.md', same)
    // The copy sorts first by name but was created later; on APFS an earlier mtime moves birth back.
    const past = new Date(Date.now() - 3600_000)
    await utimes(join(root, 'Plan.md'), past, past)
    const { ws } = await opened()
    const byTitle = Object.fromEntries(ws.tree().map((n) => [n.title, n.id]))
    expect(byTitle['Plan']).toBe('11111111-1111-4111-8111-111111111111')
    expect(byTitle['Plan (conflicted copy)']).not.toBe(byTitle['Plan'])
  })

  it('reloads favorites and order synced from another Mac, ignoring its own saves', async () => {
    const { ws, events } = await opened()
    const a = await namedPage(ws, 'A')
    const b = await namedPage(ws, 'B')
    await ws.reconcile([change('.nobsidian/workspace.json')])
    expect(events).toEqual([])
    await write(
      '.nobsidian/workspace.json',
      JSON.stringify({ version: 1, order: { root: [b, a] }, favorites: [a] })
    )
    await ws.reconcile([change('.nobsidian/workspace.json')])
    expect(events).toEqual([{ type: 'tree' }])
    expect(ws.tree().map((n) => n.id)).toEqual([b, a])
    expect(ws.favorites()).toEqual([a])
  })

  it('rescans without rereading files that did not change', async () => {
    const { ws } = await opened()
    const id = await namedPage(ws, 'Locked')
    await ws.reconcile([{ kind: 'add', path: 'Other.md' }])
    await chmod(join(root, 'Locked.md'), 0o000)
    try {
      await write('New.md', 'x\n')
      await ws.reconcile([{ kind: 'add', path: 'New.md' }])
      expect(ws.tree().map((n) => n.id)).toContain(id)
    } finally {
      await chmod(join(root, 'Locked.md'), 0o644)
    }
  })

  it('shows frontmatter that is not valid YAML as text, before and after editing', async () => {
    await write('Broken.md', '---\ntitle: [unclosed\n---\nBody\n')
    const { ws } = await opened()
    const id = ws.tree()[0].id
    const doc = await ws.readPage(id)
    expect(doc.frontmatterError).toBe(true)
    expect(doc.blocks).toEqual([
      { type: 'raw', props: { markdown: '---\ntitle: [unclosed\n---' }, children: [] },
      text('Body')
    ])
    await ws.writePage(id, [...doc.blocks, text('More')])
    expect(await read('Broken.md')).toBe(
      `---\nid: ${id}\n---\n\n---\ntitle: [unclosed\n---\n\nBody\n\nMore\n`
    )
    expect((await ws.readPage(id)).frontmatterError).toBe(true)
  })
})
