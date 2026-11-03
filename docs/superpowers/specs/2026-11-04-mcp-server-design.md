# Claude Connector (MCP Server) - Design

Date: 2026-11-04
Status: Approved in chat (in-app server over the Workspace API, Streamable HTTP on loopback with a bearer token)

## Purpose

Let Claude Code, and any other MCP client, read the user's notes and write to them while Nobsidian is open.
"Find my notes on the launch plan", "add today's standup to my Daily page" and "turn this conversation into a page under Projects" should all work from Claude without copying text by hand.

### Out of scope

Working while the app is closed, Claude Desktop's stdio-only configuration (a stdio bridge can come later and forward to the same server), remote access from other machines, OAuth, per-page permissions, attachments and drawings, page icons and covers, favorites, history and trash tools, and MCP resources and prompts.

## Approach

The server runs inside the Electron main process and calls the same `Workspace` methods the renderer uses over IPC.
A separate process reading the folder directly was rejected: page ids, sidebar order in `.nobsidian/workspace.json`, the sub-page link a new page adds to its parent, page history, the search index and the backlink graph all live in the main process, and a second writer would either copy that logic or race the app.

Every MCP write therefore goes through `Workspace.run`, the same queue as autosaves and renames, and leaves the workspace exactly as if the user had made the change in the app.
The cost is that Claude can only reach the notes while Nobsidian is running, which suits a desktop note app.

## Behavior

### Turning it on

- Settings gains a "Connections" section under Features with one row, "Claude Code", and a switch.
  It is off by default.
- Switching it on starts the server and shows:
  - the address, `http://127.0.0.1:<port>/mcp`;
  - the command to run once in a terminal, with a Copy button:
    `claude mcp add --scope user --transport http nobsidian http://127.0.0.1:<port>/mcp --header "Authorization: Bearer <token>"`;
  - a "Reset token" button, which disconnects every client until the new command is run.
- The switch's state is kept in settings, so the server starts again with the app.
- If the server cannot start, the row says why ("Port 47321 is in use by another app.") and the switch stays on so it retries at the next launch.

### Port and token

- The default port is 47321.
  The first time the server starts, if that port is taken, it takes any free port instead.
  The port that worked is saved in settings and reused from then on, so the command the user ran keeps working.
- The token is 32 random bytes, hex encoded, kept in `mcp-token` in the app's user data folder with mode 0600.
  It is not encrypted with the Keychain: the Claude configuration that uses it stores it in plain text anyway, and a Keychain prompt at launch would be worse than useless.
- `NOBSIDIAN_MCP_PORT` overrides the default port, so tests can use port 0.

### Security

- The server listens on 127.0.0.1 only.
- Requests must carry `Authorization: Bearer <token>`; the token is compared in constant time and anything else gets 401.
- The `Host` header must be a loopback name and any `Origin` header a loopback origin, which stops DNS rebinding from a web page.
- Only `/mcp` is served.
- Nothing the server does is irreversible: `trash_page` moves a page to the trash, and every content change first saves the page's previous text to its history.

### Tools

Page ids are the UUIDs in each page's frontmatter, so they stay valid across renames and moves.

| Tool | Input | What it does |
|---|---|---|
| `list_pages` | `parentId?` | The page tree (or one page's subtree) as an indented outline of titles and ids, in sidebar order. |
| `search_pages` | `query` | Up to 20 hits from the app's search index: title, id, parent path and a line of matching text. |
| `read_page` | `id` | The title, id, parent id, a `version`, and the content as Markdown. |
| `create_page` | `title`, `markdown?`, `parentId?` | Creates a page at the end of its parent (or the top level), adds a sub-page link to the parent like the app does, and returns the new id. |
| `update_page` | `id`, `markdown`, `version` | Replaces the content. Refused when the page changed since the `read_page` that returned `version`. |
| `append_to_page` | `id`, `markdown` | Adds blocks at the end of the page; needs no version, since it cannot overwrite anything. |
| `rename_page` | `id`, `title` | Renames the page and its file, updating links to it. |
| `move_page` | `id`, `parentId` (null for the top level), `index?` | Moves the page, as dragging it in the sidebar does. |
| `trash_page` | `id` | Moves the page and its sub-pages to the trash. |

Read-only tools are annotated `readOnlyHint`, `trash_page` `destructiveHint`, and the rest as non-destructive writes, so clients can ask the user accordingly.
Expected failures (no notes folder open, unknown page, stale version) come back as tool errors with a sentence the model can act on, such as "The page changed since you read it. Read it again and reapply your change."

### Markdown

Content goes in and out in Nobsidian's own Markdown dialect (design spec, section 5), converted with the same `markdownToBlocks` and `blocksToMarkdown` the app uses, so anything Claude writes is a page the editor can show.
Links between pages use `nobsidian://page/<id>` instead of relative file paths, so Claude never has to work out a path:

- `[Title](nobsidian://page/<id>)` is an inline link;
- `[Title](nobsidian://page/<id> "mention")` is an @ mention;
- `[Title](nobsidian://page/<id> "page")` on its own line is a page block.

They are written to the file as relative paths, exactly as links made in the editor are.
The server's `instructions` describe the dialect's extensions (callouts, toggles, colors, columns) in a few lines, so tool descriptions stay short.

### Versions and open pages

The editor's `revision` only changes when a page is changed by something other than the editor itself, so it cannot tell Claude whether the user typed since Claude read the page.
`version` is instead a hash of the page file's text, taken inside the queue on read and checked inside the queue on write.

A write from Claude is treated like a change from another app:

1. The page's current text is saved to its history, so "Page history" can always restore what was there before Claude wrote.
2. The new text is written, and the search index and backlinks are updated.
3. The page's `revision` goes up and a `page` event is emitted.
   An open editor with no unsaved edits reloads and shows Claude's text; one with unsaved edits shows the existing "This page was changed outside Nobsidian" banner, and its autosave is refused rather than overwriting Claude's change.
4. Changes to the page tree (create, rename, move, trash) send the sidebar a new tree, as the IPC handlers do.

## Structure

- `main/workspace/workspace.ts`: `readVersioned(id)` returns the page and its `version`; `writeOutside(id, edit, version?)` applies `edit` to the page's blocks with the steps above and returns the new version, or a conflict.
  `createPage` already takes content and adds the parent link.
- `main/mcp/tools.ts`: `createNotesServer(access)` builds an `McpServer` with the tools and instructions, over an `access` object giving the open `Workspace` (or null) and a `treeChanged()` callback.
  It knows nothing about HTTP or Electron.
- `main/mcp/http.ts`: `McpHttpServer` owns the `node:http` server: loopback binding, the host, origin and token checks, and one stateless `NodeStreamableHTTPServerTransport` and `McpServer` per request.
- `main/mcp/service.ts`: `McpService` owns the token file, the port and enabled settings, starting and stopping, and the status shown in Settings.
- `main/mcp/handlers.ts`: IPC for `mcp:status`, `mcp:setEnabled` and `mcp:resetToken`.
- `renderer/src/components/SettingsModal.tsx`: the Connections page.

Dependencies: `@modelcontextprotocol/server` and `@modelcontextprotocol/node` (the v2 SDK, which pulls in Hono and Zod rather than Express), and `@modelcontextprotocol/client` for tests.

## Testing

- Unit tests for `writeOutside`: the stale-version refusal, the history copy, the revision bump and event, and page links written as relative paths.
- Unit tests that start `McpHttpServer` on port 0 over a temporary workspace and drive it with the SDK's client: every tool, the 401 for a missing or wrong token, and the 403 for a foreign `Host`.
- An end-to-end test that turns the connector on in Settings, reads the command shown there, connects with the SDK client from the test, and checks that:
  - a page Claude creates appears in the sidebar and in its parent;
  - a page open in a tab reloads with the text Claude wrote;
  - an open page with unsaved typing shows the conflict banner instead of losing either side.
