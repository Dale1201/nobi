import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from './workspace'
import { pageLinkHref } from '../../shared/core/links'
import type { Block } from '../../shared/core/blocks'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nobsidian-ws-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const read = (rel: string): Promise<string> => readFile(join(root, rel), 'utf8')
const text = (t: string): Block => ({
  type: 'paragraph',
  props: {},
  content: [{ type: 'text', text: t, styles: {} }],
  children: []
})

describe('Workspace scanning', () => {
  it('builds a nested tree and assigns ids to files without one', async () => {
    await writeFile(join(root, 'Projects.md'), '# Projects\n')
    await mkdir(join(root, 'Projects'))
    await writeFile(join(root, 'Projects', 'Website.md'), 'Hello\n')
    await mkdir(join(root, 'Orphan Folder'))
    await writeFile(join(root, 'Orphan Folder', 'Child.md'), '')
    const ws = await Workspace.open(root, { settleMs: 0 })
    const tree = ws.tree()
    expect(tree.map((n) => n.title)).toEqual(['Orphan Folder', 'Projects'])
    expect(tree[1].children.map((n) => n.path)).toEqual(['Projects/Website.md'])
    expect(await read('Projects/Website.md')).toMatch(/^---\nid: [0-9a-f-]{36}\n---\n\nHello\n$/)
    expect(await read('Orphan Folder.md')).toMatch(/^---\nid: /)
  })

  it('refuses to open a folder that does not exist', async () => {
    await expect(Workspace.open(join(root, 'missing'))).rejects.toThrow('Folder not found')
    await expect(readdir(join(root, 'missing'))).rejects.toThrow()
  })

  it('ignores attachments and the app folder', async () => {
    await mkdir(join(root, 'attachments'))
    await writeFile(join(root, 'attachments', 'note.md'), 'not a page')
    await mkdir(join(root, '.nobsidian'))
    const ws = await Workspace.open(root, { settleMs: 0 })
    expect(ws.tree()).toEqual([])
  })

  it('gives duplicated ids a fresh one', async () => {
    const same = '---\nid: 11111111-1111-1111-1111-111111111111\n---\n'
    await writeFile(join(root, 'A.md'), same)
    await writeFile(join(root, 'B.md'), same)
    const ws = await Workspace.open(root, { settleMs: 0 })
    const ids = ws.tree().map((n) => n.id)
    expect(new Set(ids).size).toBe(2)
  })
})

describe('Workspace page operations', () => {
  it('creates, writes and reads pages', async () => {
    const ws = await Workspace.open(root, { settleMs: 0 })
    const a = await ws.createPage(null)
    const b = await ws.createPage(null)
    expect([a.path, b.path]).toEqual(['Untitled.md', 'Untitled (2).md'])
    expect(await read('Untitled (2).md')).toContain('title: ""')
    await ws.writePage(a.id, [text('Body')])
    const doc = await ws.readPage(a.id)
    expect(doc.blocks).toEqual([text('Body')])
    expect(await read('Untitled.md')).toBe(`---\nid: ${a.id}\ntitle: ""\n---\n\nBody\n`)
  })

  it('creates a page with a title and content', async () => {
    const ws = await Workspace.open(root, { settleMs: 0 })
    const parent = await ws.createPage(null)
    const target = await ws.createPage(parent.id)
    const link: Block = { type: 'pageLink', props: { href: pageLinkHref(target.id) }, children: [] }
    const p = await ws.createPage(null, undefined, {
      title: 'Recovered edits',
      blocks: [text('Kept words'), link]
    })
    expect(p.path).toBe('Recovered edits.md')
    expect(await read(p.path)).toContain('Kept words\n\n[Untitled](Untitled/Untitled.md "page")')
    expect((await ws.readPage(p.id)).blocks).toEqual([text('Kept words'), link])
    expect((await ws.search('kept')).map((h) => h.id)).toEqual([p.id])
  })

  it('renames a page with its children and rewrites links', async () => {
    const ws = await Workspace.open(root, { settleMs: 0 })
    const parent = await ws.createPage(null)
    const child = await ws.createPage(parent.id)
    const other = await ws.createPage(null)
    await ws.writePage(other.id, [
      { type: 'pageLink', props: { href: pageLinkHref(child.id) }, children: [] }
    ])
    expect(await read(other.path)).toContain('[Untitled](Untitled/Untitled.md "page")')
    await ws.renamePage(parent.id, 'Projects / 2026')
    expect(ws.tree()[0].path).toBe('Projects - 2026.md')
    expect(await read('Projects - 2026.md')).toContain('title: Projects / 2026')
    expect(await readdir(join(root, 'Projects - 2026'))).toEqual(['Untitled.md'])
    expect(await read(other.path)).toContain('(Projects%20-%202026/Untitled.md "page")')
    const doc = await ws.readPage(other.id)
    expect(doc.blocks[0]).toMatchObject({
      type: 'pageLink',
      props: { href: pageLinkHref(child.id) }
    })
  })

  it('keeps mentions pointing at a renamed page, with its new title on save', async () => {
    const ws = await Workspace.open(root, { settleMs: 0 })
    const target = await ws.createPage(null)
    await ws.renamePage(target.id, 'Plans')
    const other = await ws.createPage(null)
    const blocks: Block[] = [
      {
        type: 'paragraph',
        props: {},
        content: [
          { type: 'pageMention', props: { href: pageLinkHref(target.id), title: 'Plans' } }
        ],
        children: []
      }
    ]
    await ws.writePage(other.id, blocks)
    expect(await read(other.path)).toContain('[Plans](Plans.md "mention")')
    await ws.renamePage(target.id, 'Roadmap')
    expect(await read(other.path)).toContain('(Roadmap.md "mention")')
    await ws.writePage(other.id, blocks)
    expect(await read(other.path)).toContain('[Roadmap](Roadmap.md "mention")')
  })

  it('finds a page by the current title of a page it mentions', async () => {
    const ws = await Workspace.open(root, { settleMs: 0 })
    const target = await ws.createPage(null)
    await ws.renamePage(target.id, 'Plans')
    const other = await ws.createPage(null)
    const blocks: Block[] = [
      {
        type: 'paragraph',
        props: {},
        content: [
          { type: 'pageMention', props: { href: pageLinkHref(target.id), title: 'Plans' } }
        ],
        children: []
      }
    ]
    await ws.renamePage(target.id, 'Roadmap')
    await ws.writePage(other.id, blocks)
    expect((await ws.search('Roadmap')).map((h) => h.id)).toContain(other.id)
  })

  it('moves a page and keeps its relative links working', async () => {
    const ws = await Workspace.open(root, { settleMs: 0 })
    const target = await ws.createPage(null)
    await ws.renamePage(target.id, 'Target')
    const mover = await ws.createPage(null)
    await ws.renamePage(mover.id, 'Mover')
    const asset = await ws.saveAttachment('cat photo.png', new Uint8Array([1, 2, 3]))
    expect(asset).toBe('/attachments/cat%20photo.png')
    await ws.writePage(mover.id, [
      { type: 'image', props: { url: asset, caption: '' }, children: [] },
      text('x')
    ])
    expect(await read('Mover.md')).toContain('![](attachments/cat%20photo.png)')
    await ws.movePage(mover.id, target.id, 0)
    expect(await read('Target/Mover.md')).toContain('![](../attachments/cat%20photo.png)')
    expect(ws.tree()[0].children.map((c) => c.title)).toEqual(['Mover'])
    await expect(readdir(join(root, 'Mover'))).rejects.toThrow()
  })

  it('never names a root page like the attachments folder', async () => {
    const ws = await Workspace.open(root, { settleMs: 0 })
    const p = await ws.createPage(null)
    await ws.renamePage(p.id, 'Attachments')
    expect(ws.tree()[0]).toMatchObject({ title: 'Attachments', path: 'Attachments (2).md' })
  })

  it('refuses to move a page into its own descendant', async () => {
    const ws = await Workspace.open(root, { settleMs: 0 })
    const a = await ws.createPage(null)
    const b = await ws.createPage(a.id)
    await expect(ws.movePage(a.id, b.id, 0)).rejects.toThrow('inside itself')
  })

  it('reorders siblings and persists the order', async () => {
    const ws = await Workspace.open(root, { settleMs: 0 })
    const a = await ws.createPage(null)
    const b = await ws.createPage(null)
    await ws.movePage(b.id, null, 0)
    expect(ws.tree().map((n) => n.id)).toEqual([b.id, a.id])
    const reopened = await Workspace.open(root, { settleMs: 0 })
    expect(reopened.tree().map((n) => n.id)).toEqual([b.id, a.id])
  })

  it('trashes a page with its children and keeps links serializable', async () => {
    const ws = await Workspace.open(root, { settleMs: 0 })
    const a = await ws.createPage(null)
    await ws.createPage(a.id)
    const keep = await ws.createPage(null)
    await ws.writePage(keep.id, [
      { type: 'pageLink', props: { href: pageLinkHref(a.id) }, children: [] }
    ])
    await ws.setFavorite(a.id, true)
    await ws.trashPage(a.id)
    expect(ws.tree().map((n) => n.id)).toEqual([keep.id])
    expect(ws.favorites()).toEqual([])
    const trash = await readdir(join(root, '.nobsidian', 'trash'))
    expect(trash).toHaveLength(1)
    expect((await readdir(join(root, '.nobsidian', 'trash', trash[0]))).sort()).toEqual([
      'Untitled',
      'Untitled.md',
      'meta.json'
    ])
    await ws.writePage(keep.id, (await ws.readPage(keep.id)).blocks)
    expect(await read(keep.path)).toContain('(Untitled.md "page")')
  })

  it('updates icon, cover and full width in frontmatter', async () => {
    const ws = await Workspace.open(root, { settleMs: 0 })
    const p = await ws.createPage(null)
    const cover = await ws.saveAttachment('cover.jpg', new Uint8Array([9]))
    await ws.updateMeta(p.id, { icon: '🚀', cover, coverPosition: 30, fullWidth: true })
    expect(await read(p.path)).toBe(
      `---\nid: ${p.id}\ntitle: ""\nicon: 🚀\ncover: attachments/cover.jpg\ncoverPosition: 30\nfullWidth: true\n---\n`
    )
    const doc = await ws.readPage(p.id)
    expect(doc.meta).toMatchObject({ icon: '🚀', cover: '/attachments/cover.jpg', fullWidth: true })
    expect(ws.tree()[0].icon).toBe('🚀')
  })

  it('serializes concurrent writes', async () => {
    const ws = await Workspace.open(root, { settleMs: 0 })
    const p = await ws.createPage(null)
    await Promise.all([
      ws.writePage(p.id, [text('one')]),
      ws.renamePage(p.id, 'Renamed'),
      ws.writePage(p.id, [text('two')])
    ])
    expect(await read('Renamed.md')).toBe(`---\nid: ${p.id}\n---\n\ntwo\n`)
  })

  it('numbers drawings before their double extension', async () => {
    const ws = await Workspace.open(root, { settleMs: 0 })
    const svg = new TextEncoder().encode('<svg/>')
    expect(await ws.saveAttachment('Drawing.excalidraw.svg', svg)).toBe(
      '/attachments/Drawing.excalidraw.svg'
    )
    expect(await ws.saveAttachment('Drawing.excalidraw.svg', svg)).toBe(
      '/attachments/Drawing%20(2).excalidraw.svg'
    )
  })

  it('reads drawings, and nothing else, from the workspace', async () => {
    const ws = await Workspace.open(root, { settleMs: 0 })
    const href = await ws.saveAttachment('a.excalidraw.svg', new TextEncoder().encode('<svg/>'))
    await writeFile(join(root, 'secret.svg'), '<svg/>')
    await mkdir(join(root, '.nobsidian'), { recursive: true })
    await writeFile(join(root, '.nobsidian', 'x.excalidraw.svg'), '<svg/>')
    expect(await ws.readDrawing(href)).toBe('<svg/>')
    expect(await ws.readDrawing('/attachments/missing.excalidraw.svg')).toBeNull()
    expect(await ws.readDrawing('/secret.svg')).toBeNull()
    expect(await ws.readDrawing('/.nobsidian/x.excalidraw.svg')).toBeNull()
  })

  it('refuses asset paths outside the workspace', async () => {
    const ws = await Workspace.open(root, { settleMs: 0 })
    expect(ws.resolveAsset('/../../etc/passwd')).toBe(join(root, 'etc', 'passwd'))
    expect(ws.resolveAsset('/.nobsidian/workspace.json')).toBeNull()
  })
})

describe('Workspace keeps existing notes intact', () => {
  it('keeps a page whose child folder differs only in case', async () => {
    await writeFile(join(root, 'Notes.md'), 'important content\n')
    await mkdir(join(root, 'notes'))
    await writeFile(join(root, 'notes', 'Child.md'), 'child\n')
    const ws = await Workspace.open(root, { settleMs: 0 })
    expect(await read('Notes.md')).toContain('important content')
    expect(ws.tree()).toHaveLength(1)
    expect(ws.tree()[0].children.map((c) => c.title)).toEqual(['Child'])
  })

  it('only adds an id when opening existing notes, leaving the rest byte for byte', async () => {
    const body =
      '# Plan\n\nSee [[Other]] and ![badge](https://x/b.svg) inline, press <kbd>Ctrl</kbd>.\n\n* a\n* b\n'
    await writeFile(join(root, 'Plan.md'), body)
    await writeFile(join(root, 'Meta.md'), '---\n# a comment\ntags: [x, y]\n---\nBody *text*\n')
    await writeFile(join(root, 'Bom.md'), '\uFEFF---\nid: abc\ntitle: T\n---\n\nHello\n')
    const ws = await Workspace.open(root, { settleMs: 0 })
    const plan = await read('Plan.md')
    const front = /^---\nid: [0-9a-f-]{36}\n---\n\n/
    expect(plan).toMatch(front)
    expect(plan.replace(front, '')).toBe(body)
    expect(await read('Meta.md')).toMatch(
      /^---\n# a comment\ntags: \[x, y\]\nid: [0-9a-f-]{36}\n---\nBody \*text\*\n$/
    )
    expect(await read('Bom.md')).toBe('\uFEFF---\nid: abc\ntitle: T\n---\n\nHello\n')
    expect(ws.tree().find((n) => n.id === 'abc')?.title).toBe('T')
  })

  it('reads a page only after queued writes have landed', async () => {
    const ws = await Workspace.open(root, { settleMs: 0 })
    const p = await ws.createPage(null)
    const other = await ws.createPage(null)
    void ws.renamePage(other.id, 'Renamed')
    void ws.writePage(p.id, [text('latest')])
    expect((await ws.readPage(p.id)).blocks).toEqual([text('latest')])
  })

  it('keeps image icons working after a move', async () => {
    const ws = await Workspace.open(root, { settleMs: 0 })
    const a = await ws.createPage(null)
    await ws.renamePage(a.id, 'A')
    const b = await ws.createPage(null)
    await ws.renamePage(b.id, 'B')
    const icon = await ws.saveAttachment('i.png', new Uint8Array([1]))
    await ws.updateMeta(b.id, { icon })
    await ws.movePage(b.id, a.id, 0)
    expect(ws.tree()[0].children[0].icon).toBe('/attachments/i.png')
    expect(await read('A/B.md')).toContain('icon: ../attachments/i.png')
  })

  it('renames without reading pages that do not link to the renamed page', async () => {
    const ws = await Workspace.open(root, { settleMs: 0 })
    const p = await ws.createPage(null)
    const other = await ws.createPage(null)
    await ws.writePage(other.id, [text('unrelated')])
    await chmod(join(root, other.path), 0o000)
    try {
      await ws.renamePage(p.id, 'Fresh name')
      expect(ws.tree().map((n) => n.title)).toContain('Fresh name')
    } finally {
      await chmod(join(root, other.path), 0o644)
    }
  })
})

describe('Workspace links sub-pages from their parent', () => {
  const pageLink = (id: string): Block => ({
    type: 'pageLink',
    props: { href: pageLinkHref(id) },
    children: []
  })

  it('adds a link at the end of the parent when asked, and tells open editors', async () => {
    const ws = await Workspace.open(root, { settleMs: 0 })
    const parent = await ws.createPage(null, undefined, { title: 'Aztec', blocks: [text('Idea')] })
    const events: unknown[] = []
    ws.onEvent((e) => events.push(e))
    const child = await ws.createPage(parent.id, undefined, undefined, { link: true })
    await ws.renamePage(child.id, 'Subpage')
    expect(await read('Aztec.md')).toMatch(/Idea\n\n\[Subpage\]\(Aztec\/Subpage\.md "page"\)\n$/)
    expect(events).toContainEqual({ type: 'page', id: parent.id, revision: 1 })
    expect((await ws.readPage(parent.id)).blocks).toEqual([text('Idea'), pageLink(child.id)])
  })

  it('leaves the parent alone without the link option', async () => {
    const ws = await Workspace.open(root, { settleMs: 0 })
    const parent = await ws.createPage(null, undefined, { title: 'Aztec', blocks: [text('Idea')] })
    await ws.createPage(parent.id)
    expect((await ws.readPage(parent.id)).blocks).toEqual([text('Idea')])
  })

  it('moves the link along with a page that changes parent', async () => {
    const ws = await Workspace.open(root, { settleMs: 0 })
    const from = await ws.createPage(null, undefined, { title: 'From', blocks: [] })
    const to = await ws.createPage(null, undefined, { title: 'To', blocks: [text('Home')] })
    const child = await ws.createPage(from.id, undefined, undefined, { link: true })
    await ws.writePage(from.id, [text('Before'), pageLink(child.id), text('After')])
    await ws.movePage(child.id, to.id, 0)
    expect((await ws.readPage(from.id)).blocks).toEqual([text('Before'), text('After')])
    expect((await ws.readPage(to.id)).blocks).toEqual([text('Home'), pageLink(child.id)])
    await ws.movePage(child.id, null, 0)
    expect((await ws.readPage(to.id)).blocks).toEqual([text('Home')])
  })

  it('does not touch the parent when a page is only reordered', async () => {
    const ws = await Workspace.open(root, { settleMs: 0 })
    const parent = await ws.createPage(null, undefined, { title: 'P', blocks: [text('x')] })
    const a = await ws.createPage(parent.id)
    await ws.createPage(parent.id)
    await ws.movePage(a.id, parent.id, 1)
    expect((await ws.readPage(parent.id)).blocks).toEqual([text('x')])
  })

  it('links a duplicate right after the original', async () => {
    const ws = await Workspace.open(root, { settleMs: 0 })
    const parent = await ws.createPage(null, undefined, { title: 'Plan', blocks: [] })
    const step = await ws.createPage(parent.id, undefined, { title: 'Step', blocks: [] })
    await ws.writePage(parent.id, [pageLink(step.id), text('Notes')])
    const copy = await ws.duplicatePage(step.id)
    expect((await ws.readPage(parent.id)).blocks).toEqual([
      pageLink(step.id),
      pageLink(copy.id),
      text('Notes')
    ])
  })
})

describe('Writes from outside the editor', () => {
  it('refuse a stale version, and make an editor holding the old revision conflict', async () => {
    await writeFile(join(root, 'A.md'), 'Before\n')
    const ws = await Workspace.open(root, { settleMs: 0 })
    const id = ws.tree()[0].id
    const { doc, version } = await ws.readVersioned(id)
    const written = await ws.writeOutside(id, () => [text('Claude')], version)
    expect(written).toMatchObject({ ok: true })
    expect(await ws.writeOutside(id, () => [text('Again')], version)).toEqual({
      ok: false,
      reason: 'conflict'
    })
    expect(await ws.writePage(id, [text('Typed')], { revision: doc.revision })).toEqual({
      ok: false,
      reason: 'conflict'
    })
    expect(await read('A.md')).toBe(`---\nid: ${id}\n---\n\nClaude\n`)
    expect((await ws.readVersioned(id)).version).toBe(written.ok && written.version)
  })
})
