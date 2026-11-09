# Nobi

A Notion-like note app for macOS: Electron, React and BlockNote, with each page a Markdown file in the user's folder.
Notion is the yardstick for look and behaviour, and the Markdown files are the source of truth.
`README.md` covers the commands and how notes are stored; design specs and plans are in `docs/superpowers/`.

## Layout

- `src/main`: the Electron main process. `workspace/` owns the files on disk (scan, ids, links, external edits); `ai/`, `search/`, `history/` and `import/` sit beside it.
- `src/renderer/src`: the React UI. `store.ts` holds app state (tree, tabs, settings), `editor/` the BlockNote editor, `ai/` the Writer.
- `src/shared`: types, the IPC contract (`ipc.ts`) and `core/`, the Markdown and blocks conversion both processes use.
- `e2e/`: Playwright against the built app; `e2e-packaged/` checks the packaged app launches.

## Setup

- Use Node 24: run `source ~/.nvm/nvm.sh && nvm use` before any `pnpm` command.
- Run `pnpm install` after merging main; new dependencies land often and the build fails without them.

## End-to-end tests

- They run the app in `out/`, so run `pnpm exec electron-vite build` after any change under `src/` (`pnpm test:e2e` builds for you).
- Test windows stay hidden; set `NOBI_E2E_SHOW=1` to see them.
- The `nb` fixture gives each test a fresh, empty workspace.
- A test that needs pages on disk starts with `nbWith({ files, aiKey })` instead, which writes them before the first launch.
  Don't write files and then `nb.relaunch()`: that launches twice, and a file changed under a second before a scan joins the sidebar a second later.
  Keep `nb.relaunch()` for tests of what survives a restart.
- Before adding a test, look for an existing one with the same setup to extend, and leave logic a unit test can check to vitest.
- The `anthropic` fixture fakes the API. To check a state shown while an answer streams, pause it with `hold: true` and `anthropic.release()`, since a busy renderer can skip any in-between frame.
- Key presses never reach native menus; use `menu()` or `clickMenuItem()` from `e2e/helpers.ts`.
- Tests tagged `@clipboard` run one at a time because the macOS clipboard is shared.

## Before pushing

CI tests the branch merged with main on slow 3-core macOS runners, so races show up there that a fast Mac hides.

1. Merge main.
2. Run `pnpm typecheck && pnpm lint && pnpm test`.
3. Build, then run all three e2e shards at once, each with its own output: `CI=1 pnpm exec playwright test --shard=N/3 --output=test-results/shardN` for N = 1, 2, 3.
4. Run the three shards again with `--workers=5` each to add load.

Treat any failure as a flake to fix, even one that only shows under load.
