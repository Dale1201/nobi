import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Block } from '../../shared/core/blocks'
import { pageLinkHref } from '../../shared/core/links'
import { Workspace } from './workspace'

let root: string
let clock: Date

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nobi-trash-'))
  clock = new Date('2026-10-21T10:00:00.000Z')
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const open = (): Promise<Workspace> => Workspace.open(root, { now: () => clock, settleMs: 0 })
const read = (rel: string): Promise<string> => readFile(join(root, rel), 'utf8')
const text = (t: string): Block => ({
  type: 'paragraph',
  props: {},
  content: [{ type: 'text', text: t, styles: {} }],
  children: []
})
const link = (id: string): Block => ({
  type: 'pageLink',
  props: { href: pageLinkHref(id) },
  children: []
})

async function page(ws: Workspace, parentId: string | null, title: string): Promise<string> {
  const { id } = await ws.createPage(parentId)
  await ws.renamePage(id, title)
  return id
}

describe('Trash', () => {
  it('lists deleted pages newest first with their parent and sub-page count', async () => {
    const ws = await open()
    const parent = await page(ws, null, 'Parent')
    const a = await page(ws, parent, 'A')
    const aChild = await page(ws, a, 'A child')
    await ws.updateMeta(a, { icon: '🚀' })
    const b = await page(ws, null, 'B')
    await ws.trashPage(a)
    clock = new Date('2026-10-21T11:00:00.000Z')
    await ws.trashPage(b)
    const items = await ws.listTrash()
    expect(items.map((i) => [i.title, i.parentTitle, i.pageCount, i.deletedAt])).toEqual([
      ['B', null, 1, '2026-10-21T11:00:00.000Z'],
      ['A', 'Parent', 2, '2026-10-21T10:00:00.000Z']
    ])
    expect(items[1].icon).toBe('🚀')
    expect(items[1].pageId).toBe(a)
    expect(items[1].pageIds).toEqual([a, aChild])
  })

  it('opens a deleted page read-only with links to live pages resolved', async () => {
    const ws = await open()
    const target = await page(ws, null, 'Target')
    const gone = await page(ws, null, 'Gone')
    await ws.writePage(gone, [text('Remember this'), link(target)])
    await ws.trashPage(gone)
    const [item] = await ws.listTrash()
    const doc = await ws.readTrash(item.entry)
    expect(doc).toMatchObject({
      id: gone,
      title: 'Gone',
      blocks: [text('Remember this'), link(target)]
    })
  })

  it('restores a page with its sub-pages to the original place', async () => {
    const ws = await open()
    const parent = await page(ws, null, 'Parent')
    const a = await page(ws, parent, 'A')
    const child = await page(ws, a, 'Child')
    const other = await page(ws, null, 'Other')
    await ws.writePage(other, [link(child)])
    await ws.trashPage(a)
    const [item] = await ws.listTrash()
    expect(await ws.restoreTrash(item.entry)).toBe(a)
    const parentNode = ws.tree().find((n) => n.id === parent)!
    expect(parentNode.children.map((n) => n.title)).toEqual(['A'])
    expect(parentNode.children[0].children.map((n) => n.id)).toEqual([child])
    expect(await read('Parent/A/Child.md')).toContain(`id: ${child}`)
    expect(await ws.listTrash()).toEqual([])
    expect(await read('Other.md')).toContain('(Parent/A/Child.md "page")')
  })

  it("removes a page's link from its parent, and puts it back in place on restore", async () => {
    const ws = await open()
    const parent = await page(ws, null, 'Parent')
    const a = await page(ws, parent, 'A')
    const other = await page(ws, null, 'Other')
    await ws.writePage(parent, [text('Before'), link(a), text('After')])
    await ws.writePage(other, [link(a)])
    const events: unknown[] = []
    ws.onEvent((e) => events.push(e))
    await ws.trashPage(a)
    expect((await ws.readPage(parent)).blocks).toEqual([text('Before'), text('After')])
    expect(events).toContainEqual(expect.objectContaining({ type: 'page', id: parent }))
    expect(await read('Other.md')).toContain('(Parent/A.md "page")')
    const [item] = await ws.listTrash()
    await ws.restoreTrash(item.entry)
    expect((await ws.readPage(parent)).blocks).toEqual([text('Before'), link(a), text('After')])
    expect(await read('Parent.md')).toContain('Before\n\n[A](Parent/A.md "page")\n\nAfter\n')
  })

  it('puts a link nested alone under a toggle back inside it on restore', async () => {
    const ws = await open()
    const parent = await page(ws, null, 'Parent')
    const a = await page(ws, parent, 'A')
    const toggle = (children: Block[]): Block => ({
      type: 'toggleListItem',
      props: {},
      content: [{ type: 'text', text: 'Archive', styles: {} }],
      children
    })
    await ws.writePage(parent, [toggle([link(a)]), text('After')])
    await ws.trashPage(a)
    expect((await ws.readPage(parent)).blocks).toEqual([toggle([]), text('After')])
    const [item] = await ws.listTrash()
    await ws.restoreTrash(item.entry)
    expect((await ws.readPage(parent)).blocks).toEqual([toggle([link(a)]), text('After')])
  })

  it('does not link a restored page from a parent that never linked it', async () => {
    const ws = await open()
    const parent = await page(ws, null, 'Parent')
    const a = await page(ws, parent, 'A')
    await ws.writePage(parent, [text('Body')])
    await ws.trashPage(a)
    const [item] = await ws.listTrash()
    await ws.restoreTrash(item.entry)
    expect((await ws.readPage(parent)).blocks).toEqual([text('Body')])
  })

  it('restores to the top level when the parent is gone, renaming on conflict and fixing links', async () => {
    const ws = await open()
    const parent = await page(ws, null, 'Parent')
    const a = await page(ws, parent, 'Notes')
    const child = await page(ws, a, 'Child')
    await page(ws, null, 'Notes')
    const other = await page(ws, null, 'Other')
    await ws.writePage(other, [link(child)])
    await ws.writePage(child, [link(other)])
    await ws.trashPage(a)
    await ws.trashPage(parent)
    const entry = (await ws.listTrash()).find((i) => i.pageId === a)!.entry
    await ws.restoreTrash(entry)
    const restored = ws.tree().find((n) => n.id === a)!
    expect(restored).toMatchObject({ title: 'Notes', path: 'Notes (2).md' })
    expect(await read('Notes (2).md')).toContain('title: Notes')
    expect(await read('Other.md')).toContain('(Notes%20\\(2\\)/Child.md "page")')
    expect(await read('Notes (2)/Child.md')).toContain('(../Other.md "page")')
    expect(
      ws
        .tree()
        .map((n) => n.id)
        .at(-1)
    ).toBe(a)
  })

  it('puts a restored page back in its old position, and back in Favorites', async () => {
    const ws = await open()
    const a = await page(ws, null, 'A')
    const b = await page(ws, null, 'B')
    const c = await page(ws, null, 'C')
    await ws.setFavorite(b, true)
    await ws.trashPage(b)
    expect(ws.favorites()).toEqual([])
    const [item] = await ws.listTrash()
    await ws.restoreTrash(item.entry)
    expect(ws.tree().map((n) => n.id)).toEqual([a, b, c])
    expect(ws.favorites()).toEqual([b])
  })

  it('puts sub-pages that were in Favorites back there too', async () => {
    const ws = await open()
    const a = await page(ws, null, 'A')
    const child = await page(ws, a, 'Child')
    const grandchild = await page(ws, child, 'Grandchild')
    const other = await page(ws, null, 'Other')
    await ws.setFavorite(grandchild, true)
    await ws.setFavorite(other, true)
    await ws.setFavorite(a, true)
    await ws.trashPage(a)
    expect(ws.favorites()).toEqual([other])
    const [item] = await ws.listTrash()
    await ws.restoreTrash(item.entry)
    expect(ws.favorites()).toEqual([other, a, grandchild])
  })

  it('leaves links to a newer page with the same name alone', async () => {
    const ws = await open()
    const old = await page(ws, null, 'Ideas')
    await ws.trashPage(old)
    const fresh = await page(ws, null, 'Ideas')
    const other = await page(ws, null, 'Other')
    await ws.writePage(other, [link(fresh)])
    const [item] = await ws.listTrash()
    await ws.restoreTrash(item.entry)
    expect(ws.tree().find((n) => n.id === old)?.path).toBe('Ideas (2).md')
    expect(await read('Other.md')).toContain('[Ideas](Ideas.md "page")')
  })

  it('keeps links from a trashed page to pages renamed while it was in Trash', async () => {
    const ws = await open()
    const a = await page(ws, null, 'A')
    const b = await page(ws, null, 'B')
    await ws.writePage(a, [link(b)])
    await ws.trashPage(a)
    await ws.renamePage(b, 'B2')
    const [item] = await ws.listTrash()
    await ws.restoreTrash(item.entry)
    expect(await read('A.md')).toContain('[B2](B2.md "page")')
  })

  it('restores a page whose id a live page took meanwhile, without touching the live one', async () => {
    const ws = await open()
    const a = await page(ws, null, 'A')
    await ws.writePage(a, [text('trashed copy')])
    await ws.checkpoint(a)
    await ws.trashPage(a)
    // A sync tool brings back a file with the same id under another name.
    await writeFile(join(root, 'Synced.md'), `---\nid: ${a}\n---\n\nlive copy\n`)
    await ws.reconcile([{ kind: 'add', path: 'Synced.md' }])
    const [item] = await ws.listTrash()
    const restoredId = await ws.restoreTrash(item.entry)
    expect(restoredId).not.toBe(a)
    expect(ws.tree().find((n) => n.id === a)?.title).toBe('Synced')
    expect(ws.tree().find((n) => n.id === restoredId)?.title).toBe('A')
    await ws.trashPage(restoredId)
    const [again] = await ws.listTrash()
    await ws.deleteTrash(again.entry)
    expect(await readdir(join(root, '.nobi', 'history', a))).not.toEqual([])
  })

  it('cleans up an entry whose page never arrived', async () => {
    const dir = join(root, '.nobi', 'trash', '2026-10-21T09-00-00-000Z-x')
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'meta.json'),
      JSON.stringify({
        id: 'x',
        title: 'Gone',
        originalPath: 'Gone.md',
        parentId: null,
        deletedAt: '2026-10-21T09:00:00.000Z'
      })
    )
    const ws = await open()
    expect(await ws.listTrash()).toEqual([])
    expect(await readdir(join(root, '.nobi', 'trash'))).toEqual([])
  })

  it('keeps an entry whose page file is gone but whose sub-pages are still there', async () => {
    const ws = await open()
    const a = await page(ws, null, 'A')
    const child = await page(ws, a, 'Child')
    await ws.writePage(child, [text('Child content')])
    await ws.trashPage(a)
    const [item] = await ws.listTrash()
    await unlink(join(root, '.nobi', 'trash', item.entry, 'A.md'))
    expect((await ws.listTrash()).map((i) => [i.title, i.pageCount])).toEqual([['A', 2]])
    await ws.restoreTrash(item.entry)
    const restored = ws.tree().find((n) => n.title === 'A')!
    expect(restored.children.map((n) => n.id)).toEqual([child])
    expect(await read('A/Child.md')).toContain('Child content')
  })

  it('deletes forever, removing the history of every page in the entry', async () => {
    const ws = await open()
    const a = await page(ws, null, 'A')
    const child = await page(ws, a, 'Child')
    await ws.writePage(a, [text('one')])
    await ws.writePage(child, [text('two')])
    await ws.checkpoint()
    expect(await readdir(join(root, '.nobi', 'history'))).toHaveLength(2)
    await ws.trashPage(a)
    const [item] = await ws.listTrash()
    await ws.deleteTrash(item.entry)
    expect(await ws.listTrash()).toEqual([])
    expect(await readdir(join(root, '.nobi', 'history'))).toEqual([])
    expect(await readdir(join(root, '.nobi', 'trash'))).toEqual([])
  })

  it('purges entries older than 30 days', async () => {
    const ws = await open()
    await ws.trashPage(await page(ws, null, 'Old'))
    clock = new Date('2026-11-15T10:00:00.000Z')
    await ws.trashPage(await page(ws, null, 'Recent'))
    clock = new Date('2026-11-21T10:00:00.000Z')
    await ws.maintain()
    expect((await ws.listTrash()).map((i) => i.title)).toEqual(['Recent'])
  })

  it('skips trash entries it cannot read and refuses unsafe entry names', async () => {
    await mkdir(join(root, '.nobi', 'trash', 'broken'), { recursive: true })
    await writeFile(join(root, '.nobi', 'trash', 'broken', 'meta.json'), '{')
    const ws = await open()
    expect(await ws.listTrash()).toEqual([])
    await expect(ws.restoreTrash('../../x')).rejects.toThrow('Unknown trash item')
  })
})

describe('Duplicate', () => {
  it('copies a page and its sub-pages below the original, pointing internal links at the copies', async () => {
    const ws = await open()
    const outside = await page(ws, null, 'Outside')
    const a = await page(ws, null, 'Plan')
    const child = await page(ws, a, 'Step')
    await page(ws, null, 'Last')
    await ws.updateMeta(a, { icon: '🚀' })
    await ws.writePage(a, [text('Body'), link(child), link(outside)])
    await ws.setFavorite(a, true)
    const copy = await ws.duplicatePage(a)
    expect(ws.tree().map((n) => n.title)).toEqual(['Outside', 'Plan', 'Plan (1)', 'Last'])
    expect(copy).toMatchObject({ title: 'Plan (1)', path: 'Plan (1).md', icon: '🚀' })
    const childCopy = copy.children[0]
    expect(childCopy).toMatchObject({ title: 'Step', path: 'Plan (1)/Step.md' })
    expect(childCopy.id).not.toBe(child)
    const doc = await ws.readPage(copy.id)
    expect(doc.blocks).toEqual([text('Body'), link(childCopy.id), link(outside)])
    expect(await read('Plan (1).md')).toContain('[Step](Plan%20\\(1\\)/Step.md "page")')
    expect(ws.favorites()).toEqual([a])
    const hits = await ws.search('body')
    expect(hits.map((h) => h.id).sort()).toEqual([a, copy.id].sort())
  })

  it('names a copy of an untitled page "Untitled (1)"', async () => {
    const ws = await open()
    const p = await ws.createPage(null)
    expect((await ws.duplicatePage(p.id)).title).toBe('Untitled (1)')
  })
})
