import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  net,
  protocol,
  screen,
  shell,
  type Rectangle
} from 'electron'
import { join, normalize, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { is } from '@electron-toolkit/utils'
import { ASSET_SCHEME, EXCALIDRAW_HOST } from '../shared/ipc'
import { contextMenuTemplate } from './contextMenu'
import {
  openWorkspace,
  registerHandlers,
  treeChanged,
  updateMenu,
  type AppContext
} from './handlers'
import { ImportService } from './import/service'
import { startImportWorker } from './import/start-worker'
import { send } from './ipc'
import { buildMenu } from './menu'
import { SettingsStore } from './settings'
import { migrateUserData } from './userData'
import { safeStorageCodec, testCodec } from './ai/codecs'
import { registerAiHandlers } from './ai/handlers'
import { KeyStore } from './ai/keyStore'
import { AiService } from './ai/service'
import { UsageLedger } from './ai/usage'
import { DEFAULT_AI_MODEL, isAiModel } from '../shared/ai'
import { DEFAULT_MCP_PORT } from '../shared/mcp'
import { registerMcpHandlers } from './mcp/handlers'
import { McpService } from './mcp/service'
import { windowControls } from '../shared/window'

if (process.env.NOBI_USER_DATA) app.setPath('userData', process.env.NOBI_USER_DATA)
else migrateUserData(app.getPath('appData'), app.getPath('userData'))

// Test runs stay off screen and never take focus; NOBI_E2E_SHOW=1 shows them for debugging.
const hidden = process.env.NOBI_E2E === '1' && process.env.NOBI_E2E_SHOW !== '1'
if (hidden && process.platform === 'darwin') app.setActivationPolicy('accessory')

protocol.registerSchemesAsPrivileged([
  {
    scheme: ASSET_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true
    }
  }
])

// The build copies Excalidraw's fonts next to the renderer; the dev server has no such folder.
const EXCALIDRAW_FONTS = process.env.ELECTRON_RENDERER_URL
  ? join(__dirname, '../../node_modules/@excalidraw/excalidraw/dist/prod/fonts')
  : join(__dirname, '../renderer/excalidraw/fonts')

function excalidrawFont(pathname: string): string | null {
  const path = normalize(decodeURIComponent(pathname))
  if (!path.startsWith('/fonts/')) return null
  const file = join(EXCALIDRAW_FONTS, path.slice('/fonts/'.length))
  return file.startsWith(EXCALIDRAW_FONTS + sep) ? file : null
}

let mainWindow: BrowserWindow | null = null
let quitting = false
app.on('before-quit', () => {
  quitting = true
})
const ctx: AppContext = {
  settings: new SettingsStore(join(app.getPath('userData'), 'settings.json')),
  workspace: null,
  watcher: null,
  maintainTimer: null,
  imports: new ImportService(startImportWorker, (status) => {
    if (mainWindow) send(mainWindow.webContents, 'import:status', status)
  }),
  window: () => mainWindow
}

const ai = new AiService({
  keys: new KeyStore(
    join(app.getPath('userData'), 'anthropic-key.json'),
    process.env.NOBI_E2E === '1' ? testCodec : safeStorageCodec
  ),
  usage: new UsageLedger(join(app.getPath('userData'), 'ai-usage.json')),
  model: () => {
    const model = ctx.settings.get().ai?.model
    return isAiModel(model) ? model : DEFAULT_AI_MODEL
  }
})

const mcp = new McpService({
  settings: ctx.settings,
  tokenFile: join(app.getPath('userData'), 'mcp-token'),
  defaultPort: process.env.NOBI_MCP_PORT ? Number(process.env.NOBI_MCP_PORT) : DEFAULT_MCP_PORT,
  access: { workspace: () => ctx.workspace, treeChanged: () => treeChanged(ctx) },
  version: app.getVersion()
})

/** Saved bounds, unless the display they were on is gone. */
function restoredBounds(): Partial<Rectangle> {
  const saved = ctx.settings.get().windowBounds
  if (!saved) return { width: 1280, height: 820 }
  const area = screen.getDisplayMatching(saved).workArea
  const visible =
    saved.x < area.x + area.width &&
    saved.x + saved.width > area.x &&
    saved.y < area.y + area.height &&
    saved.y + saved.height > area.y
  return visible ? saved : { width: saved.width, height: saved.height }
}

function createWindow(): void {
  const controls = windowControls(process.getSystemVersion())
  const win = new BrowserWindow({
    ...restoredBounds(),
    minWidth: 720,
    minHeight: 480,
    show: false,
    title: 'Nobi',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: controls.x, y: controls.y },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#191919' : '#ffffff',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: !hidden
    }
  })
  mainWindow = win

  if (!hidden) win.on('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('context-menu', (_event, params) => {
    const template = contextMenuTemplate(params, {
      replace: (suggestion) => win.webContents.replaceMisspelling(suggestion),
      addToDictionary: (word) => win.webContents.session.addWordToSpellCheckerDictionary(word)
    })
    if (template.length > 0) Menu.buildFromTemplate(template).popup({ window: win })
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (!(
      is.dev &&
      process.env.ELECTRON_RENDERER_URL &&
      url.startsWith(process.env.ELECTRON_RENDERER_URL)
    )) {
      event.preventDefault()
    }
  })

  // Give the renderer a moment to write pending edits before the window goes away.
  // Cancelling the close also cancels an app quit, so the quit is re-issued afterwards.
  let flushed = false
  let closing = false
  win.on('close', (event) => {
    if (flushed) return
    event.preventDefault()
    if (closing) return
    closing = true
    if (ctx.imports.running) {
      // An import being added finishes first; one still reading can be discarded.
      const ask = ctx.imports.cancellable ? discardImport(win, quitting) : Promise.resolve(true)
      void ask.then(async (discard) => {
        closing = false
        if (!discard) {
          quitting = false
          return
        }
        await ctx.imports.stop()
        win.close()
      })
      return
    }
    const saving = ctx.settings.set({ windowBounds: win.getNormalBounds() }).catch(() => {})
    let answered = false
    const finish = async (saved: boolean): Promise<void> => {
      if (answered) return
      answered = true
      clearTimeout(timeout)
      if (!saved && !(await closeAnyway(win, quitting))) {
        closing = false
        quitting = false
        return
      }
      flushed = true
      await saving
      await ctx.workspace?.checkpoint().catch(() => {})
      if (quitting) app.quit()
      else win.close()
    }
    ipcMain.removeHandler('app:flushed')
    ipcMain.handle('app:flushed', (_event, { saved }: { saved: boolean }) => finish(saved))
    send(win.webContents, 'app:flush', undefined)
    const timeout = setTimeout(() => void finish(true), 2000)
  })
  win.on('closed', () => {
    mainWindow = null
  })
  win.on('enter-full-screen', () => send(win.webContents, 'window:fullscreen', true))
  win.on('leave-full-screen', () => send(win.webContents, 'window:fullscreen', false))

  if (is.dev && process.env.ELECTRON_RENDERER_URL)
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

/** Asks before closing while an import runs; true discards it. */
async function discardImport(win: BrowserWindow, quitting: boolean): Promise<boolean> {
  const verb = quitting ? 'Quit' : 'Close'
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    message: `An import is running. ${verb} and discard it?`,
    detail: 'Nothing from it has been added yet.',
    buttons: ['Cancel', `${verb} and Discard`],
    defaultId: 0,
    cancelId: 0
  })
  return response === 1
}

/** Asks before closing over edits the renderer could not save; they are still on screen. */
async function closeAnyway(win: BrowserWindow, quitting: boolean): Promise<boolean> {
  const verb = quitting ? 'Quit' : 'Close'
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    message: "Some edits couldn't be saved.",
    detail: `They're still on screen. If you ${verb.toLowerCase()} now, they'll be lost.`,
    buttons: ['Cancel', `${verb} Anyway`],
    defaultId: 0,
    cancelId: 0
  })
  return response === 1
}

app.whenReady().then(async () => {
  const settings = await ctx.settings.load()
  if (settings.lastWorkspace) {
    try {
      await openWorkspace(ctx, settings.lastWorkspace)
    } catch {
      ctx.workspace = null
    }
  }

  protocol.handle(ASSET_SCHEME, async (request) => {
    const url = new URL(request.url)
    if (url.host === EXCALIDRAW_HOST) {
      const file = excalidrawFont(url.pathname)
      if (!file) return new Response('Not found', { status: 404 })
      // Fonts are fetched with CORS from the file:// page.
      const response = await net.fetch(pathToFileURL(file).toString())
      return new Response(response.body, {
        headers: { 'Content-Type': 'font/woff2', 'Access-Control-Allow-Origin': '*' }
      })
    }
    const file = ctx.workspace?.resolveAsset(url.pathname)
    if (!file) return new Response('Not found', { status: 404 })
    return net.fetch(pathToFileURL(file).toString())
  })

  registerHandlers(ctx)
  registerAiHandlers(ai)
  registerMcpHandlers(mcp)
  Menu.setApplicationMenu(buildMenu(() => mainWindow))
  updateMenu(ctx)
  createWindow()
  void mcp.start()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
