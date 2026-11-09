# Nobi

[![CI](https://github.com/Dale1201/nobsidian/actions/workflows/ci.yml/badge.svg)](https://github.com/Dale1201/nobsidian/actions/workflows/ci.yml)

An open-source, Notion-like note-taking app for macOS.
Your notes are plain Markdown files in a folder you choose, so they stay yours.

## Features

- Notion-style block editor: `/` commands, drag handles, toggles, callouts, columns, tables, code, math.
- Drawings: type `/drawing` to sketch with [Excalidraw](https://excalidraw.com) in a full-window editor; the page shows the drawing as a picture.
- Nested pages in a sidebar, with emoji or image icons and page covers.
  Like Notion, a page added, moved or duplicated inside another shows as a link in its parent.
- Notion's look, in light and dark mode.
- Quick search (Cmd+K or Cmd+P) across titles and text, with recent pages.
- Tabs like Notion's desktop app: Cmd+T, Cmd-click or middle-click to open, drag to reorder, Cmd+Shift+T to reopen, and each notes folder's tabs come back after a restart.
- Edit with AI, like Notion's Writer: select text and press Cmd+J, or Space on an empty line, to improve, proofread, shorten, translate, summarize or continue with Claude, using your own Anthropic API key; changes show as a diff to accept or undo.
- Let Claude Code read and edit your notes: turn it on in Settings > Connections and run the command shown there once.
  Claude can search, read, create, edit, move and trash pages while the app is open; what it replaces stays in page history.
- Favorites, duplicate, move to, and a table of contents block.
- Trash with restore, and page history with restore.
- Edits made in other apps, Finder or a sync folder show up live, without losing yours.
- Import from Notion: export your workspace from Notion as HTML (with sub-pages), then drop the zip on the window or use File > Import from Notion.
  Pages keep their nesting, colors, icons, covers, images and links, and a report lists anything that could not be converted exactly.
- Paste from Notion keeps the formatting of what you copied.

## Development

Requires Node 24 (see `.nvmrc`) and pnpm.

```bash
pnpm install
pnpm dev          # run the app with hot reload
pnpm test         # unit tests
pnpm test:e2e     # end-to-end tests against the built app
pnpm test:packaged # package the app and check it launches
pnpm lint
pnpm typecheck
pnpm build:mac    # Apple Silicon .dmg in dist/
```

Every pull request runs the type check, lint, unit, end-to-end and packaged-app tests on a macOS runner (`.github/workflows/ci.yml`).

The app is ad-hoc signed rather than signed with an Apple Developer ID, so a downloaded copy needs right-click → Open the first time you launch it.

## How notes are stored

Each page is a `.md` file; a page's child pages live in a folder with the same name.
Images and files go in `attachments/`, and app data (favorites, page order, trash, page history) lives in `.nobi/`.
A drawing is an `.excalidraw.svg` file in `attachments/`, linked from the page like any image, so other Markdown apps show it as a picture; the SVG carries the editable drawing, which excalidraw.com and the Excalidraw VS Code extension can also open.
Notion-only formatting uses small Markdown extensions, described in `docs/superpowers/specs/2026-10-21-nobsidian-design.md`.
Opening an existing folder only adds an `id` to each note's frontmatter; a note is rewritten in Nobi's Markdown style only when you edit it, and anything the editor can't show (raw HTML, wikilinks, footnotes) is kept exactly as written.

## License

GPL-3.0-or-later.
