import { BrowserWindow, clipboard, dialog, Menu, shell } from 'electron'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { TreeSnapshot } from '../shared/ipc'
import type { WorkspaceInfo } from '../shared/types'
import { downloadImage } from './import/download'
import type { ImportService } from './import/service'
import { peekExport } from './import/zip'
import { handle, send } from './ipc'
import { IMPORT_MENU_ID } from './menu'
import type { SettingsStore } from './settings'
import { exists } from './workspace/fs-utils'
import { watchWorkspace, type WorkspaceWatcher } from './workspace/watcher'
import { Workspace } from './workspace/workspace'

export interface AppContext {
  settings: SettingsStore
  workspace: Workspace | null
  watcher: WorkspaceWatcher | null
  maintainTimer: ReturnType<typeof setTimeout> | null
  imports: ImportService
  window: () => BrowserWindow | null
}

/** File > Import from Notion works only while a workspace is open. */
export function updateMenu(ctx: AppContext): void {
  const item = Menu.getApplicationMenu()?.getMenuItemById(IMPORT_MENU_ID)
  if (item) item.enabled = ctx.workspace !== null
}

export function workspaceInfo(ws: Workspace): WorkspaceInfo {
  return { root: ws.root, name: basename(ws.root) }
}

export function snapshot(ws: Workspace): TreeSnapshot {
  return { pages: ws.tree(), favorites: ws.favorites() }
}

/** Sends the sidebar the page tree after a change it did not make itself. */
export function treeChanged(ctx: AppContext): void {
  const win = ctx.window()
  if (win && ctx.workspace) send(win.webContents, 'tree:changed', snapshot(ctx.workspace))
}

export async function openWorkspace(ctx: AppContext, root: string): Promise<WorkspaceInfo> {
  const ws = await Workspace.open(root)
  await closeWorkspace(ctx)
  ctx.workspace = ws
  await ctx.settings.set({ lastWorkspace: root })
  ws.onEvent((event) => {
    const win = ctx.window()
    if (!win || ctx.workspace !== ws) return
    if (event.type === 'tree') send(win.webContents, 'tree:changed', snapshot(ws))
    else send(win.webContents, 'page:changed', { id: event.id, revision: event.revision })
  })
  const lost = async (): Promise<void> => {
    if (ctx.workspace !== ws || (await exists(root))) return
    if (ctx.workspace !== ws) return
    await closeWorkspace(ctx, { checkpoint: false })
    const win = ctx.window()
    if (win) send(win.webContents, 'workspace:missing', undefined)
  }
  ctx.watcher = watchWorkspace(
    root,
    (changes) => {
      if (changes.some((c) => c.kind === 'unlinkDir' && c.path === '')) void lost()
      else void ws.reconcile(changes).catch((err) => console.error('Reconcile failed', err))
    },
    () => void lost()
  )
  updateMenu(ctx)
  void ws.indexContent().catch((err) => console.error('Indexing failed', err))
  // Housekeeping can wait until the window is up.
  ctx.maintainTimer = setTimeout(() => {
    void ws.maintain().catch((err) => console.error('Workspace maintenance failed', err))
  }, 1000)
  return workspaceInfo(ws)
}

export async function closeWorkspace(
  ctx: AppContext,
  { checkpoint = true }: { checkpoint?: boolean } = {}
): Promise<void> {
  await ctx.imports.stop()
  const { watcher, workspace } = ctx
  if (ctx.maintainTimer) clearTimeout(ctx.maintainTimer)
  ctx.maintainTimer = null
  ctx.watcher = null
  ctx.workspace = null
  updateMenu(ctx)
  await watcher?.close()
  if (checkpoint) await workspace?.checkpoint().catch(() => {})
  workspace?.close()
}

export function registerHandlers(ctx: AppContext): void {
  const ws = (): Workspace => {
    if (!ctx.workspace) throw new Error('No workspace is open')
    return ctx.workspace
  }
  const mutate =
    <P, R>(fn: (w: Workspace, p: P) => Promise<R>) =>
    async (p: P): Promise<R> => {
      const result = await fn(ws(), p)
      treeChanged(ctx)
      return result
    }

  handle('workspace:current', () => (ctx.workspace ? workspaceInfo(ctx.workspace) : null))
  handle('workspace:choose', async () => {
    const win = ctx.window()
    const options: Electron.OpenDialogOptions = {
      title: 'Choose a folder for your notes',
      buttonLabel: 'Use this folder',
      properties: ['openDirectory', 'createDirectory']
    }
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    return openWorkspace(ctx, result.filePaths[0])
  })
  handle('tree:get', () => snapshot(ws()))
  handle('page:read', ({ id }) => ws().readPage(id))
  handle('page:write', ({ id, blocks, revision, force }) =>
    ws().writePage(id, blocks, { revision, force })
  )
  handle(
    'page:meta',
    mutate((w, { id, patch }) => w.updateMeta(id, patch))
  )
  handle(
    'page:create',
    mutate((w, { parentId, index, title = '', blocks = [], link }) =>
      w.createPage(parentId, index, { title, blocks }, { link })
    )
  )
  handle(
    'page:rename',
    mutate((w, { id, title }) => w.renamePage(id, title))
  )
  handle(
    'page:move',
    mutate((w, { id, parentId, index }) => w.movePage(id, parentId, index))
  )
  handle(
    'page:trash',
    mutate((w, { id }) => w.trashPage(id))
  )
  handle(
    'page:duplicate',
    mutate((w, { id }) => w.duplicatePage(id))
  )
  handle(
    'page:favorite',
    mutate((w, { id, favorite }) => w.setFavorite(id, favorite))
  )
  handle('search:query', ({ query }) => ws().search(query))
  handle('page:backlinks', ({ id }) => ws().backlinks(id))
  handle('trash:list', () => ws().listTrash())
  handle('trash:read', ({ entry }) => ws().readTrash(entry))
  handle(
    'trash:restore',
    mutate((w, { entry }) => w.restoreTrash(entry))
  )
  handle('trash:delete', ({ entry }) => ws().deleteTrash(entry))
  handle('history:list', ({ id }) => ws().listHistory(id))
  handle('history:read', ({ id, version }) => ws().readHistory(id, version))
  handle(
    'history:restore',
    mutate((w, { id, version }) => w.restoreHistory(id, version))
  )
  handle('history:checkpoint', ({ id }) => ws().checkpoint(id))
  handle('history:draft', ({ id, blocks }) => ws().keepDraft(id, blocks))
  handle('attachment:save', ({ name, data }) => ws().saveAttachment(name, data))
  handle('attachment:chooseImage', async () => {
    const win = ctx.window()
    const options: Electron.OpenDialogOptions = {
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] }]
    }
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    const file = result.filePaths[0]
    return ws().saveAttachment(basename(file), new Uint8Array(await readFile(file)))
  })
  handle('attachment:open', async ({ href }) => {
    const file = ws().resolveAsset(href)
    if (file) await shell.openPath(file)
  })
  handle('drawing:read', ({ href }) => ws().readDrawing(href))
  handle('attachment:fetch', async ({ url }) => {
    const image = await downloadImage(url)
    return ws().saveAttachment(image.name, image.data)
  })
  handle('import:choose', async () => {
    if (ctx.imports.running) throw new Error('An import is already running.')
    const win = ctx.window()
    const options: Electron.OpenDialogOptions = {
      title: 'Import from Notion',
      message: 'Choose the zip files Notion exported (Export format: HTML).',
      buttonLabel: 'Import',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Notion export', extensions: ['zip'] }]
    }
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return false
    await ctx.imports.start(ws(), result.filePaths)
    return true
  })
  handle('import:start', ({ paths }) => ctx.imports.start(ws(), paths))
  handle('import:cancel', async () => {
    await ctx.imports.cancel()
  })
  handle('import:peek', ({ paths }) => Promise.all(paths.map((p) => peekExport(p))))
  handle('notion:pages', ({ notionIds }) => ws().findNotionPages(notionIds))
  handle('settings:get', () => ctx.settings.get())
  handle('settings:set', (patch) => ctx.settings.set(patch))
  handle('shell:openExternal', async ({ url }) => {
    if (/^(https?|mailto):/i.test(url)) await shell.openExternal(url)
  })
  handle('clipboard:writeText', ({ text }) => clipboard.writeText(text))
  handle('window:close', () => {
    ctx.window()?.close()
  })
}
