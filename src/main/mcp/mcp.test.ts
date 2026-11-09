import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { Workspace, type WorkspaceEvent } from '../workspace/workspace'
import { McpHttpServer } from './http'
import { createNotesServer } from './tools'

const TOKEN = 'a'.repeat(64)

let root: string
let ws: Workspace | null
let http: McpHttpServer
let url: string
let client: Client
let treeChanges: number

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nobi-mcp-'))
  await writeFile(join(root, 'Projects.md'), 'All my projects.\n')
  ws = await Workspace.open(root, { settleMs: 0 })
  treeChanges = 0
  http = new McpHttpServer({
    token: () => TOKEN,
    createServer: () =>
      createNotesServer({ workspace: () => ws, treeChanged: () => treeChanges++ }, '0.0.0')
  })
  url = `http://127.0.0.1:${await http.listen(0)}/mcp`
  client = await connect(TOKEN)
})
afterEach(async () => {
  await client.close()
  await http.close()
  ws?.close()
  await rm(root, { recursive: true, force: true })
})

async function connect(token: string): Promise<Client> {
  const c = new Client({ name: 'test', version: '0.0.0' })
  await c.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } }
    })
  )
  return c
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = await client.callTool({ name, arguments: args })
  const text = (result.content as { type: string; text: string }[]).map((c) => c.text).join('')
  if (result.isError) throw new Error(text)
  return text
}

const idIn = (text: string): string => /\(id: ([0-9a-f-]{36})\)/.exec(text)![1]
const versionIn = (text: string): string => /^version: (\w+)$/m.exec(text)![1]
const read = (rel: string): Promise<string> => readFile(join(root, rel), 'utf8')

function status(headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', headers }, (res) => {
      res.resume()
      resolve(res.statusCode!)
    })
    req.on('error', reject)
    req.end('{}')
  })
}

describe('the MCP server', () => {
  it('offers the note tools and explains the Markdown dialect', async () => {
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([
      'append_to_page',
      'create_page',
      'list_pages',
      'move_page',
      'read_page',
      'rename_page',
      'search_pages',
      'trash_page',
      'update_page'
    ])
    expect(tools.find((t) => t.name === 'read_page')?.annotations?.readOnlyHint).toBe(true)
    expect(tools.find((t) => t.name === 'trash_page')?.annotations?.destructiveHint).toBe(true)
    expect(client.getInstructions()).toContain('nobi://page/<id>')
  })

  it('refuses requests without the token or from a foreign host', async () => {
    const json = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream'
    }
    expect(await status(json)).toBe(401)
    expect(await status({ ...json, Authorization: `Bearer ${'b'.repeat(64)}` })).toBe(401)
    expect(await status({ ...json, Authorization: `Bearer ${TOKEN}`, Host: 'evil.example' })).toBe(
      403
    )
    expect(
      await status({ ...json, Authorization: `Bearer ${TOKEN}`, Origin: 'https://evil.example' })
    ).toBe(403)
    await expect(connect('wrong')).rejects.toThrow()
  })

  it('creates pages inside others and links them from the parent', async () => {
    const projects = idIn(await call('list_pages'))
    const created = await call('create_page', {
      title: 'Launch',
      parentId: projects,
      markdown: '# Goals\n\n- Ship it\n'
    })
    const launch = idIn(created)
    expect(treeChanges).toBe(1)
    expect(await call('list_pages')).toBe(
      `- Projects (id: ${projects})\n  - Launch (id: ${launch})`
    )
    expect(await read('Projects/Launch.md')).toBe(
      `---\nid: ${launch}\n---\n\n# Goals\n\n- Ship it\n`
    )
    expect(await read('Projects.md')).toContain('[Launch](Projects/Launch.md "page")')
  })

  it('reads and replaces content, refusing a stale version', async () => {
    const id = idIn(await call('list_pages'))
    const page = await call('read_page', { id })
    expect(page).toMatch(
      /^title: Projects\nid: .*\nparent: none \(top level\)\nversion: \w+\n\nAll my projects\.\n$/
    )
    const version = versionIn(page)
    await call('update_page', { id, markdown: 'Rewritten.', version })
    expect(await read('Projects.md')).toBe(`---\nid: ${id}\n---\n\nRewritten.\n`)
    await expect(call('update_page', { id, markdown: 'Again.', version })).rejects.toThrow(
      'The page changed since you read it.'
    )
    expect(await read('Projects.md')).toContain('Rewritten.')
    const history = await ws!.listHistory(id)
    const texts = await Promise.all(history.map((h) => ws!.readHistory(id, h.id)))
    expect(texts.some((doc) => JSON.stringify(doc.blocks).includes('All my projects.'))).toBe(true)
  })

  it('appends, and tells open editors the page changed', async () => {
    const id = idIn(await call('list_pages'))
    const events: WorkspaceEvent[] = []
    ws!.onEvent((e) => events.push(e))
    await call('append_to_page', { id, markdown: '- [ ] Call Sam' })
    expect(await read('Projects.md')).toBe(
      `---\nid: ${id}\n---\n\nAll my projects.\n\n- [ ] Call Sam\n`
    )
    expect(events).toEqual([{ type: 'page', id, revision: 1 }])
  })

  it('writes page links as relative paths and reads them back as ids', async () => {
    const projects = idIn(await call('list_pages'))
    const notes = idIn(
      await call('create_page', {
        title: 'Notes',
        markdown: `See [Projects](nobi://page/${projects} "mention").`
      })
    )
    expect(await read('Notes.md')).toContain('[Projects](Projects.md "mention")')
    expect(await call('read_page', { id: notes })).toContain(
      `See [Projects](nobi://page/${projects} "mention").`
    )
  })

  it('reads a page block back with the title of the page it links to', async () => {
    const projects = idIn(await call('list_pages'))
    const launch = idIn(await call('create_page', { title: 'Launch', parentId: projects }))
    expect(await call('read_page', { id: projects })).toContain(
      `[Launch](nobi://page/${launch} "page")`
    )
    await call('rename_page', { id: launch, title: 'Launch day' })
    expect(await call('read_page', { id: projects })).toContain(
      `[Launch day](nobi://page/${launch} "page")`
    )
  })

  it('searches, renames, moves and trashes pages', async () => {
    const projects = idIn(await call('list_pages'))
    const idea = idIn(await call('create_page', { title: 'Idea', markdown: 'A zeppelin café.' }))
    expect(await call('search_pages', { query: 'zeppelin' })).toBe(
      `- Idea (id: ${idea})\n  A zeppelin café.`
    )
    await call('rename_page', { id: idea, title: 'Big idea' })
    await call('move_page', { id: idea, parentId: projects })
    expect(await call('search_pages', { query: 'zeppelin' })).toBe(
      `- Big idea (id: ${idea})\n  in: Projects\n  A zeppelin café.`
    )
    expect(await read('Projects/Big idea.md')).toContain('A zeppelin café.')
    await call('trash_page', { id: idea })
    expect(await call('list_pages', { parentId: projects })).toBe('No pages.')
    expect(await ws!.listTrash()).toHaveLength(1)
    expect(treeChanges).toBe(4)
  })

  it('explains unknown ids and a closed workspace', async () => {
    await expect(call('read_page', { id: 'nope' })).rejects.toThrow(
      'No page has the id nope. Use search_pages or list_pages to find one.'
    )
    ws!.close()
    ws = null
    await expect(call('list_pages')).rejects.toThrow('No notes folder is open in Nobi.')
  })

  it('checks a parent id as it checks a page id, and lets null mean the top level', async () => {
    const projects = idIn(await call('list_pages'))
    const missing = 'No page has the id gone. Use search_pages or list_pages to find one.'
    await expect(call('list_pages', { parentId: 'gone' })).rejects.toThrow(missing)
    await expect(call('create_page', { title: 'Lost', parentId: 'gone' })).rejects.toThrow(missing)
    await expect(call('move_page', { id: projects, parentId: 'gone' })).rejects.toThrow(missing)
    expect(treeChanges).toBe(0)
    const a = idIn(await call('create_page', { title: 'A', parentId: projects }))
    await call('create_page', { title: 'B' })
    await call('move_page', { id: a, parentId: null, index: 0 })
    expect((await call('list_pages')).split('\n').map((line) => line.split(' (')[0])).toEqual([
      '- A',
      '- Projects',
      '- B'
    ])
  })

  it('reports what the notes folder refuses as a tool error', async () => {
    const projects = idIn(await call('list_pages'))
    const launch = idIn(await call('create_page', { title: 'Launch', parentId: projects }))
    await expect(call('move_page', { id: projects, parentId: launch })).rejects.toThrow(
      'A page cannot be moved inside itself'
    )
    expect(await call('list_pages')).toBe(
      `- Projects (id: ${projects})\n  - Launch (id: ${launch})`
    )
  })

  it('places deep pages in the outline, their breadcrumb and their parent line', async () => {
    const projects = idIn(await call('list_pages'))
    const launch = idIn(await call('create_page', { title: 'Launch', parentId: projects }))
    const day = idIn(
      await call('create_page', { title: 'Day one', parentId: launch, markdown: 'Balloons.' })
    )
    expect(await call('list_pages')).toBe(
      `- Projects (id: ${projects})\n  - Launch (id: ${launch})\n    - Day one (id: ${day})`
    )
    expect(await call('list_pages', { parentId: projects })).toBe(
      `- Launch (id: ${launch})\n  - Day one (id: ${day})`
    )
    expect(await call('search_pages', { query: 'balloons' })).toBe(
      `- Day one (id: ${day})\n  in: Projects / Launch\n  Balloons.`
    )
    expect(await call('read_page', { id: day })).toContain(`\nparent: Launch (id: ${launch})\n`)
    expect(await call('search_pages', { query: 'zeppelin' })).toBe('No pages match.')
  })

  it('lists at most 20 search results', async () => {
    for (let i = 0; i < 21; i++) {
      await call('create_page', { title: `Note ${i}`, markdown: 'Shared word.' })
    }
    const hits = (await call('search_pages', { query: 'shared' })).match(/^- /gm)
    expect(hits).toHaveLength(20)
  })
})
