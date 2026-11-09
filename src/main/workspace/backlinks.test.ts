import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from './workspace'
import { pageLinkHref } from '../../shared/core/links'
import type { Block, Inline } from '../../shared/core/blocks'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nobi-backlinks-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const para = (...content: Inline[]): Block => ({
  type: 'paragraph',
  props: {},
  content,
  children: []
})
const mention = (id: string): Inline => ({
  type: 'pageMention',
  props: { href: pageLinkHref(id), title: 'x' }
})
const link = (id: string): Inline => ({
  type: 'link',
  href: pageLinkHref(id),
  content: [{ type: 'text', text: 'see', styles: {} }]
})
const linkBlock = (id: string): Block => ({
  type: 'pageLink',
  props: { href: pageLinkHref(id) },
  children: []
})

async function named(
  ws: Workspace,
  title: string,
  parentId: string | null = null
): Promise<string> {
  const page = await ws.createPage(parentId, undefined, { title, blocks: [] }, { link: true })
  return page.id
}

describe('Workspace.backlinks', () => {
  it('lists pages that mention, link or link-block a page, by title', async () => {
    const ws = await Workspace.open(root, { settleMs: 0 })
    const target = await named(ws, 'Target')
    const b = await named(ws, 'B mentions')
    const a = await named(ws, 'A links')
    const c = await named(ws, 'C link block')
    await named(ws, 'D unrelated')
    await ws.writePage(b, [para(mention(target))])
    await ws.writePage(a, [para(link(target))])
    await ws.writePage(c, [linkBlock(target)])
    expect(await ws.backlinks(target)).toEqual([a, b, c])
  })

  it("skips a parent's sub-page block and a page's links to itself", async () => {
    const ws = await Workspace.open(root, { settleMs: 0 })
    const parent = await named(ws, 'Parent')
    const child = await named(ws, 'Child', parent)
    expect(await readFile(join(root, 'Parent.md'), 'utf8')).toContain('(Parent/Child.md "page")')
    await ws.writePage(child, [para(mention(child))])
    expect(await ws.backlinks(child)).toEqual([])
    await ws.writePage(parent, [linkBlock(child), para(mention(child))])
    expect(await ws.backlinks(child)).toEqual([parent])
  })

  it('follows renames, moves and trash', async () => {
    const ws = await Workspace.open(root, { settleMs: 0 })
    const target = await named(ws, 'Target')
    const folder = await named(ws, 'Folder')
    const source = await named(ws, 'Source')
    await ws.writePage(source, [para(mention(target))])
    await ws.renamePage(target, 'Renamed')
    expect(await ws.backlinks(target)).toEqual([source])
    await ws.movePage(target, folder, 0)
    expect(await ws.backlinks(target)).toEqual([source])
    await ws.movePage(source, folder, 0)
    expect(await ws.backlinks(target)).toEqual([source])
    await ws.trashPage(source)
    expect(await ws.backlinks(target)).toEqual([])
    const [entry] = await ws.listTrash()
    await ws.restoreTrash(entry.entry)
    expect(await ws.backlinks(target)).toEqual([source])
  })

  it('sees links from files read at startup and edited outside the app', async () => {
    await writeFile(join(root, 'Target.md'), '---\nid: t\n---\n\nHello\n')
    await writeFile(join(root, 'Notes.md'), '---\nid: n\n---\n\nSee [Target](Target.md)\n')
    const ws = await Workspace.open(root, { settleMs: 0 })
    await ws.indexContent()
    expect(await ws.backlinks('t')).toEqual(['n'])
    await writeFile(join(root, 'Notes.md'), '---\nid: n\n---\n\nNo links now\n')
    await ws.reconcile([{ kind: 'change', path: 'Notes.md' }])
    expect(await ws.backlinks('t')).toEqual([])
  })
})
