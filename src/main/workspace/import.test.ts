import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorkspaceEvent } from './core'
import { runImport } from '../import/pipeline'
import { FIXTURE_ZIP } from '../import/test-zips'
import type { Block } from '../../shared/core/blocks'
import { sanitizeTitle } from '../../shared/core/paths'
import type { ImportManifest, StagedFile, StagedPage } from '../import/types'
import { Workspace } from './workspace'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nobsidian-import-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const read = (rel: string): Promise<string> => readFile(join(root, rel), 'utf8')
const png = (async () =>
  new Response(new Uint8Array([137, 80, 78, 71]), {
    headers: { 'content-type': 'image/png' }
  })) as unknown as typeof fetch

// Converting the fixture is the slow part, so it runs once and each test lands a copy.
let converted: { staging: string; manifest: ImportManifest }
beforeAll(async () => {
  const staging = await mkdtemp(join(tmpdir(), 'nobsidian-import-fixture-'))
  converted = { staging, manifest: await runImport({ zips: [FIXTURE_ZIP], staging, fetch: png }) }
})
afterAll(async () => {
  await rm(converted.staging, { recursive: true, force: true })
})

async function importFixture(ws: Workspace): Promise<ImportManifest & { staging: string }> {
  const staging = await ws.createImportStaging()
  await cp(converted.staging, staging, { recursive: true })
  const moved = (path?: string): string | undefined =>
    path && join(staging, path.slice(converted.staging.length))
  const { manifest } = converted
  return {
    ...structuredClone(manifest),
    files: manifest.files.map((f) => ({ ...f, path: moved(f.path) })),
    staging
  }
}

const paragraph = (value: string): Block => ({
  type: 'paragraph',
  props: {},
  content: [{ type: 'text', text: value, styles: {} }],
  children: []
})

function manifestOf(pages: StagedPage[], files: StagedFile[] = []): ImportManifest {
  return { pages, files, issues: [], sources: ['notion-export.zip'], startedAt: Date.now() }
}

describe('landing an import', () => {
  it('adds the pages under a new top-level page with working links', async () => {
    const ws = await Workspace.open(root)
    const events: WorkspaceEvent[] = []
    ws.onEvent((e) => events.push(e))
    const manifest = await importFixture(ws)
    const result = await ws.landImport(manifest, manifest.staging)

    expect(result).toMatchObject({ pages: 10, issues: 2 })
    expect(events).toContainEqual({ type: 'tree' })
    const [top] = ws.tree()
    expect(top.title).toBe('Imported from Notion')
    expect(top.children.map((c) => c.title)).toEqual(['Nobsidian import fixture', 'Import report'])
    expect(top.children[0].children.map((c) => c.title)).toEqual([
      'Child page',
      'Q&A: plans / ideas?',
      'Same name',
      'Same name',
      'Reading list'
    ])

    const fixture = await read('Imported from Notion/Nobsidian import fixture.md')
    expect(fixture).toMatch(
      /^---\nid: [\w-]+\nicon: 🧪\ncover: \.\.\/attachments\/gradients_8\.png\n/
    )
    expect(fixture).toContain('notionId: 4007c9e82e0e81549d17cfdfeaddaf81')
    expect(fixture).toContain(
      '![An uploaded image with a caption](../attachments/fixture-image.png)'
    )
    expect(fixture).toContain(
      '[Grandchild page](Nobsidian%20import%20fixture/Child%20page/Grandchild%20page.md)'
    )
    expect(fixture).toContain(
      '[Same name (2)](Nobsidian%20import%20fixture/Same%20name%20\\(2\\).md "page")'
    )
    expect(
      await read('Imported from Notion/Nobsidian import fixture/Q&A- plans - ideas-.md')
    ).toContain('title: "Q&A: plans / ideas?"')
    expect((await readdir(join(root, 'attachments'))).sort()).toEqual([
      'fixture-image.png',
      'fixture-report.pdf',
      'gradients_2.png',
      'gradients_8.png'
    ])
    expect(await readdir(join(root, '.nobsidian'))).not.toContainEqual(
      expect.stringMatching(/^import-/)
    )
    ws.close()
  })

  it('writes a report listing what was not converted exactly', async () => {
    const ws = await Workspace.open(root, { now: () => new Date('2026-10-22T10:00:00Z') })
    const manifest = await importFixture(ws)
    await ws.landImport(
      { ...manifest, startedAt: Date.parse('2026-10-22T09:59:57Z') },
      manifest.staging
    )
    expect(await read('Imported from Notion/Import report.md')).toMatch(
      new RegExp(
        'Imported 10 pages and 4 files from notion-export\\.zip on October 22, 2026 at 10:00 AM, in 3 seconds\\.\n\n' +
          '## Table formatting not kept \\(2\\)\n\n' +
          '- \\[Nobsidian import fixture\\]\\(Nobsidian%20import%20fixture\\.md\\): Header column \\(kept as a normal column\\)\n' +
          '- \\[Nobsidian import fixture\\]\\(Nobsidian%20import%20fixture\\.md\\): Table cell colors\n'
      )
    )
    ws.close()
  })

  it('lands a second import beside the first, with its own attachment names', async () => {
    const ws = await Workspace.open(root)
    for (let i = 0; i < 2; i++) {
      const manifest = await importFixture(ws)
      await ws.landImport(manifest, manifest.staging)
    }
    expect(ws.tree().map((n) => n.path)).toEqual([
      'Imported from Notion.md',
      'Imported from Notion (2).md'
    ])
    expect(ws.tree().map((n) => n.title)).toEqual([
      'Imported from Notion',
      'Imported from Notion (2)'
    ])
    expect(await read('Imported from Notion (2)/Nobsidian import fixture.md')).toContain(
      '(../attachments/fixture-image%20\\(2\\).png)'
    )
    ws.close()
  })

  it('keeps the imported pages, their order and identity after reopening', async () => {
    const ws = await Workspace.open(root)
    const manifest = await importFixture(ws)
    await ws.landImport(manifest, manifest.staging)
    const before = JSON.stringify(ws.tree())
    ws.close()
    const again = await Workspace.open(root)
    expect(JSON.stringify(again.tree())).toBe(before)
    again.close()
  })

  it('does not treat its own files as edits made outside the app', async () => {
    const ws = await Workspace.open(root)
    const manifest = await importFixture(ws)
    await ws.landImport(manifest, manifest.staging)
    const events: WorkspaceEvent[] = []
    ws.onEvent((e) => events.push(e))
    await ws.reconcile([
      { kind: 'addDir', path: 'Imported from Notion' },
      { kind: 'add', path: 'Imported from Notion.md' },
      { kind: 'add', path: 'Imported from Notion/Nobsidian import fixture.md' }
    ])
    expect(events.filter((e) => e.type === 'page')).toEqual([])
    expect(ws.tree()).toHaveLength(1)
    ws.close()
  })

  it('finds imported pages by their Notion id, quoted or not', async () => {
    const ws = await Workspace.open(root)
    const manifest = await importFixture(ws)
    await ws.landImport(manifest, manifest.staging)
    const fixture = manifest.pages[0]
    expect(ws.findNotionPages(['4007c9e82e0e81549d17cfdfeaddaf81', 'ffff'])).toEqual({
      '4007c9e82e0e81549d17cfdfeaddaf81': fixture.id
    })
    await writeFile(
      join(root, 'Digits.md'),
      "---\nid: digits\nnotionId: '12345678901234567890123456789012'\n---\n"
    )
    const reopened = (ws.close(), await Workspace.open(root))
    expect(reopened.findNotionPages(['12345678901234567890123456789012'])).toEqual({
      '12345678901234567890123456789012': 'digits'
    })
    reopened.close()
  })

  it('ignores a notionId line in a page body rather than its frontmatter', async () => {
    const ws = await Workspace.open(root)
    await writeFile(
      join(root, 'Body.md'),
      '---\nid: body\n---\n\nnotionId: aaaaaaaabbbbccccddddeeeeffff0000\n'
    )
    const reopened = (ws.close(), await Workspace.open(root))
    expect(reopened.findNotionPages(['aaaaaaaabbbbccccddddeeeeffff0000'])).toEqual({})
    reopened.close()
  })

  it('leaves attachments and the tree as they were when landing fails', async () => {
    const ws = await Workspace.open(root)
    const manifest = await importFixture(ws)
    const attachmentsBefore = await readdir(join(root, 'attachments')).catch(() => [])
    const treeBefore = JSON.stringify(ws.tree())
    // A file where the output folder should be makes the page writes fail after the files moved.
    await writeFile(join(manifest.staging, 'out'), 'not a folder')
    await expect(ws.landImport(manifest, manifest.staging)).rejects.toThrow()
    expect(await readdir(join(root, 'attachments')).catch(() => [])).toEqual(attachmentsBefore)
    expect(JSON.stringify(ws.tree())).toBe(treeBefore)
    expect((await readdir(root)).filter((n) => n.startsWith('Imported'))).toEqual([])
    ws.close()
  })

  it('lands the import when saving the state fails after the pages are added', async () => {
    const ws = await Workspace.open(root)
    const manifest = await importFixture(ws)
    // A folder where the state file should be makes saving the state fail after the pages are added.
    await rm(join(root, '.nobsidian', 'workspace.json'), { force: true })
    await mkdir(join(root, '.nobsidian', 'workspace.json'))
    const events: WorkspaceEvent[] = []
    ws.onEvent((e) => events.push(e))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const result = await ws.landImport(manifest, manifest.staging)
      expect(result.pages).toBe(10)
      expect(ws.tree().map((n) => n.title)).toEqual(['Imported from Notion'])
      expect(ws.tree()[0].children.map((n) => n.title)).toContain('Nobsidian import fixture')
      expect(events).toContainEqual({ type: 'tree' })
      expect(errors).toHaveBeenCalled()
    } finally {
      errors.mockRestore()
      ws.close()
    }
  })

  it('keeps sibling pages apart when their names differ only in Unicode form', async () => {
    const ws = await Workspace.open(root)
    const staging = await ws.createImportStaging()
    await ws.landImport(
      manifestOf([
        {
          id: 'cafe-nfc',
          parentId: null,
          title: 'Caf\u00e9',
          blocks: [paragraph('composed body')]
        },
        {
          id: 'cafe-nfd',
          parentId: null,
          title: 'Cafe\u0301',
          blocks: [paragraph('decomposed body')]
        }
      ]),
      staging
    )
    const dir = 'Imported from Notion'
    expect((await readdir(join(root, dir))).filter((n) => n.startsWith('Caf')).sort()).toEqual([
      'Caf\u00e9 (2).md',
      'Caf\u00e9.md'
    ])
    expect(await read(`${dir}/Caf\u00e9.md`)).toContain('composed body')
    expect(await read(`${dir}/Caf\u00e9 (2).md`)).toContain('decomposed body')
    ws.close()
  })

  it('keeps a page file and the folder of a sibling named like that file apart', async () => {
    const ws = await Workspace.open(root)
    const staging = await ws.createImportStaging()
    await ws.landImport(
      manifestOf([
        { id: 'foo', parentId: null, title: 'Foo', blocks: [paragraph('foo body')] },
        { id: 'foo-kid', parentId: 'foo', title: 'Kid of Foo', blocks: [paragraph('kid body')] },
        { id: 'foo-md', parentId: null, title: 'Foo.md', blocks: [paragraph('foo md body')] },
        {
          id: 'foo-md-kid',
          parentId: 'foo-md',
          title: 'Kid of Foo md',
          blocks: [paragraph('md kid body')]
        }
      ]),
      staging
    )
    const dir = 'Imported from Notion'
    expect(await read(`${dir}/Foo.md`)).toContain('foo body')
    expect(await read(`${dir}/Foo/Kid of Foo.md`)).toContain('kid body')
    expect(await read(`${dir}/Foo.md (2).md`)).toContain('foo md body')
    expect(await read(`${dir}/Foo.md (2)/Kid of Foo md.md`)).toContain('md kid body')
    ws.close()
  })

  it('drops an attachment extension that is not short and plain', async () => {
    const ws = await Workspace.open(root)
    const staging = await ws.createImportStaging()
    const name = `notes.${'x'.repeat(300)}`
    await mkdir(join(staging, 'files'), { recursive: true })
    const path = join(staging, 'files', 'key-1')
    await writeFile(path, 'bytes')
    await ws.landImport(
      manifestOf(
        [{ id: 'p', parentId: null, title: 'Page', blocks: [] }],
        [{ key: 'key-1', name, path }]
      ),
      staging
    )
    expect(await readdir(join(root, 'attachments'))).toEqual([sanitizeTitle(name)])
    ws.close()
  })
})

describe('import staging', () => {
  it('is removed when discarded, and leftovers are removed on maintenance', async () => {
    const ws = await Workspace.open(root)
    const kept = await ws.createImportStaging()
    const dropped = await ws.createImportStaging()
    await ws.discardImport(dropped)
    await mkdir(join(root, '.nobsidian', 'import-1-crashed'))
    await ws.maintain()
    const left = (await readdir(join(root, '.nobsidian'))).filter((n) => n.startsWith('import-'))
    expect(left.map((n) => join(root, '.nobsidian', n))).toEqual([kept])
    ws.close()
  })
})
