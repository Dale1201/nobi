import { McpServer, type CallToolResult } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { pageIdFromHref } from '../../shared/core/links'
import { markdownToBlocks } from '../../shared/core/parse'
import { blocksToMarkdown } from '../../shared/core/serialize'
import type { PageNode } from '../../shared/types'
import type { Workspace } from '../workspace/workspace'

export interface NotesAccess {
  /** The open notes folder, or null when none is open. */
  workspace: () => Workspace | null
  /** Pages were added, renamed, moved or trashed. */
  treeChanged: () => void
}

const INSTRUCTIONS = `Nobi is a Notion-like note app; each page is a Markdown file in the user's notes folder.
Pages are identified by id: find them with search_pages or list_pages.
A page's title is not part of its content, so don't start content with the title as a heading.

Content is Markdown (CommonMark, GFM tables and task lists, $math$) with these extensions:
- Link to another page: [Title](nobi://page/<id>). Give the link the title "mention" for an @ mention: [Title](nobi://page/<id> "mention"). [Title](nobi://page/<id> "page") on a line of its own is a page block.
- Callout: a quote whose first line is "> [!callout] 💡", then "> " lines.
- Toggle: <details><summary>Title</summary>, a blank line, the hidden blocks, </details>.
- Colors: <span data-color="red">text</span>, <span data-bg="yellow">text</span>; underline: <u>text</u>.
- An empty line kept for spacing: &nbsp; on a line of its own.
Keep any HTML or syntax you find in a page that you are not changing exactly as it is.

To change a page, read it with read_page and pass the version it returns to update_page.
To add to a page, use append_to_page, which needs no version.`

const pageId = z.string().describe('The page id, from list_pages, search_pages or read_page.')

function text(value: string): CallToolResult {
  return { content: [{ type: 'text', text: value }] }
}

function fail(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

const titleOf = (node: { title: string }): string => node.title || 'Untitled'

interface Place {
  node: PageNode
  parent: PageNode | null
}

function places(tree: PageNode[]): Map<string, Place> {
  const out = new Map<string, Place>()
  const walk = (nodes: PageNode[], parent: PageNode | null): void => {
    for (const node of nodes) {
      out.set(node.id, { node, parent })
      walk(node.children, node)
    }
  }
  walk(tree, null)
  return out
}

function outline(nodes: PageNode[], depth = 0): string[] {
  return nodes.flatMap((n) => [
    `${'  '.repeat(depth)}- ${titleOf(n)} (id: ${n.id})`,
    ...outline(n.children, depth + 1)
  ])
}

function breadcrumb(at: Map<string, Place>, id: string): string {
  const titles: string[] = []
  for (let p = at.get(id)?.parent; p; p = at.get(p.id)?.parent) titles.unshift(titleOf(p))
  return titles.join(' / ')
}

/** An MCP server whose tools read and change the notes open in the app. */
export function createNotesServer(access: NotesAccess, version: string): McpServer {
  const server = new McpServer({ name: 'nobi', version }, { instructions: INSTRUCTIONS })

  /** Runs a tool against the open workspace, turning expected failures into tool errors. */
  const withNotes =
    <A>(run: (ws: Workspace, args: A, at: Map<string, Place>) => Promise<CallToolResult>) =>
    async (args: A): Promise<CallToolResult> => {
      const ws = access.workspace()
      if (!ws) return fail('No notes folder is open in Nobi.')
      const at = places(ws.tree())
      for (const key of ['id', 'parentId'] as const) {
        const id = (args as Record<string, unknown>)[key]
        if (typeof id === 'string' && !at.has(id)) {
          return fail(`No page has the id ${id}. Use search_pages or list_pages to find one.`)
        }
      }
      try {
        return await run(ws, args, at)
      } catch (err) {
        return fail((err as Error).message)
      }
    }

  server.registerTool(
    'list_pages',
    {
      title: 'List pages',
      description: 'The page tree as an outline of titles and ids, in sidebar order.',
      inputSchema: z.object({
        parentId: pageId.optional().describe('Only list the pages inside this one.')
      }),
      annotations: { readOnlyHint: true }
    },
    withNotes(async (ws, { parentId }: { parentId?: string }, at) => {
      const nodes = parentId ? at.get(parentId)!.node.children : ws.tree()
      return text(nodes.length ? outline(nodes).join('\n') : 'No pages.')
    })
  )

  server.registerTool(
    'search_pages',
    {
      title: 'Search pages',
      description: 'Searches page titles and text, best matches first.',
      inputSchema: z.object({ query: z.string().min(1) }),
      annotations: { readOnlyHint: true }
    },
    withNotes(async (ws, { query }: { query: string }, at) => {
      const hits = (await ws.search(query)).slice(0, 20)
      if (!hits.length) return text('No pages match.')
      const lines = hits.map((hit) => {
        const place = at.get(hit.id)
        const where = breadcrumb(at, hit.id)
        return [
          `- ${place ? titleOf(place.node) : 'Untitled'} (id: ${hit.id})`,
          where && `  in: ${where}`,
          hit.snippet && `  ${hit.snippet.text}`
        ]
          .filter(Boolean)
          .join('\n')
      })
      return text(lines.join('\n'))
    })
  )

  server.registerTool(
    'read_page',
    {
      title: 'Read page',
      description: "A page's title, parent, version and content as Markdown.",
      inputSchema: z.object({ id: pageId }),
      annotations: { readOnlyHint: true }
    },
    withNotes(async (ws, { id }: { id: string }, at) => {
      const { doc, version } = await ws.readVersioned(id)
      const parent = at.get(id)?.parent
      return text(
        [
          `title: ${titleOf(doc)}`,
          `id: ${id}`,
          `parent: ${parent ? `${titleOf(parent)} (id: ${parent.id})` : 'none (top level)'}`,
          `version: ${version}`,
          '',
          blocksToMarkdown(doc.blocks, {
            pageTitle: (href) => {
              const node = at.get(pageIdFromHref(href) ?? '')?.node
              return node && titleOf(node)
            }
          })
        ].join('\n')
      )
    })
  )

  server.registerTool(
    'create_page',
    {
      title: 'Create page',
      description:
        'Creates a page at the end of its parent, or at the top level. The parent gets a link to it, as in the app.',
      inputSchema: z.object({
        title: z.string().min(1),
        markdown: z.string().optional().describe('The content; empty when left out.'),
        parentId: pageId.optional().describe('The page to create it in.')
      }),
      annotations: { readOnlyHint: false, destructiveHint: false }
    },
    withNotes(async (ws, args: { title: string; markdown?: string; parentId?: string }) => {
      const blocks = markdownToBlocks(args.markdown ?? '')
      const page = await ws.createPage(
        args.parentId ?? null,
        undefined,
        { title: args.title, blocks },
        { link: true }
      )
      access.treeChanged()
      return text(`Created "${titleOf(page)}" (id: ${page.id}).`)
    })
  )

  server.registerTool(
    'update_page',
    {
      title: 'Update page',
      description:
        "Replaces a page's content. Pass the version from read_page; if the page changed since, nothing is written.",
      inputSchema: z.object({
        id: pageId,
        markdown: z.string(),
        version: z.string().describe('The version read_page returned.')
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    withNotes(
      async (ws, { id, markdown, version }: { id: string; markdown: string; version: string }) => {
        const result = await ws.writeOutside(id, () => markdownToBlocks(markdown), version)
        if (!result.ok) {
          return fail('The page changed since you read it. Read it again and reapply your change.')
        }
        return text(`Updated. The new version is ${result.version}.`)
      }
    )
  )

  server.registerTool(
    'append_to_page',
    {
      title: 'Append to page',
      description: 'Adds content at the end of a page.',
      inputSchema: z.object({ id: pageId, markdown: z.string().min(1) }),
      annotations: { readOnlyHint: false, destructiveHint: false }
    },
    withNotes(async (ws, { id, markdown }: { id: string; markdown: string }) => {
      const added = markdownToBlocks(markdown)
      const result = await ws.writeOutside(id, (blocks) => [...blocks, ...added])
      return text(
        result.ok ? `Appended. The new version is ${result.version}.` : 'Nothing was added.'
      )
    })
  )

  server.registerTool(
    'rename_page',
    {
      title: 'Rename page',
      description: 'Renames a page; links to it follow.',
      inputSchema: z.object({ id: pageId, title: z.string().min(1) }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    withNotes(async (ws, { id, title }: { id: string; title: string }) => {
      await ws.renamePage(id, title)
      access.treeChanged()
      return text(`Renamed to "${title}".`)
    })
  )

  server.registerTool(
    'move_page',
    {
      title: 'Move page',
      description: 'Moves a page, with its sub-pages, inside another page or to the top level.',
      inputSchema: z.object({
        id: pageId,
        parentId: pageId.nullable().describe('The new parent, or null for the top level.'),
        index: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Its position among the new parent's pages; the end when left out.")
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    withNotes(
      async (
        ws,
        { id, parentId, index }: { id: string; parentId: string | null; index?: number }
      ) => {
        await ws.movePage(id, parentId, index ?? Infinity)
        access.treeChanged()
        return text('Moved.')
      }
    )
  )

  server.registerTool(
    'trash_page',
    {
      title: 'Move page to trash',
      description:
        'Moves a page and its sub-pages to the trash, where the user can restore them for 30 days.',
      inputSchema: z.object({ id: pageId }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true }
    },
    withNotes(async (ws, { id }: { id: string }) => {
      await ws.trashPage(id)
      access.treeChanged()
      return text('Moved to the trash.')
    })
  )

  return server
}
