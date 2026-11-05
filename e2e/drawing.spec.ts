import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import type { IpcProbe } from '../src/main/ipc'
import { expect, test } from './fixtures'
import {
  activePane,
  afterPendingSaves,
  clickInEditor,
  ipcCalls,
  menu,
  newPage,
  newTab,
  openFile,
  placeCaret,
  rowAction,
  waitForFile
} from './helpers'

const SQUARE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80"><rect width="120" height="80" fill="#fff"/><rect x="10" y="10" width="100" height="60" fill="none" stroke="#1e1e1e"/></svg>'

const drawingFile = (name: string): Record<string, string> => ({ [`attachments/${name}`]: SQUARE })

test('a drawing shows as its picture at the size it was drawn, is named in the block menu, and inverts in the dark theme', async ({
  nbWith
}) => {
  const { page, app } = await openFile(
    nbWith,
    'Pictures',
    'Above\n\n![](attachments/Square.excalidraw.svg)\n',
    { files: drawingFile('Square.excalidraw.svg') }
  )
  const image = page.locator('.nb-drawing img')
  await expect(image).toHaveJSProperty('naturalWidth', 120)
  await expect.poll(async () => (await image.boundingBox())?.width).toBe(120)
  await page.locator('.nb-drawing').hover()
  await page.getByRole('button', { name: 'Block menu' }).click()
  await expect(page.getByRole('menu').locator('.menu-section').first()).toHaveText('Drawing')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(image).toHaveCSS('filter', 'none')
  await menu(app, 'Toggle Dark Mode')
  await expect(image, 'the white background matches the dark page').toHaveCSS(
    'filter',
    'invert(0.9) hue-rotate(180deg)'
  )
})

test('a drawing whose file is missing says so', async ({ nbWith }) => {
  const { page } = await openFile(nbWith, 'Lost', '![](attachments/Gone.excalidraw.svg)\n')
  await expect(page.locator('.nb-drawing-missing')).toHaveText(
    'Drawing not found: Gone.excalidraw.svg'
  )
})

const overlay = (page: Page): Locator => page.getByRole('dialog', { name: 'Drawing' })

async function insertDrawing(page: Page): Promise<void> {
  await page.keyboard.type('/drawing')
  await page.keyboard.press('Enter')
  await expect(overlay(page).locator('.excalidraw')).toBeVisible()
}

async function drawRectangle(page: Page, x: number, y: number): Promise<void> {
  await page.keyboard.press('r')
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 200, y + 120, { steps: 5 })
  await page.mouse.up()
}

async function done(page: Page): Promise<void> {
  await overlay(page).getByRole('button', { name: 'Done' }).click()
  await expect(overlay(page)).toBeHidden()
}

const attachments = (workspace: string): Promise<string[]> =>
  readdir(join(workspace, 'attachments')).catch(() => [])

test('a drawing from the slash menu is saved as an editable SVG; reopening it unchanged saves nothing, and replacing its shape saves a new file', async ({
  nb
}) => {
  const { page } = nb
  await newPage(page, 'Edits')
  await insertDrawing(page)
  await drawRectangle(page, 500, 400)
  await done(page)
  const image = page.locator('.nb-drawing img')
  await expect(image).toHaveJSProperty('complete', true)
  await expect
    .poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(200)
  await waitForFile(join(nb.workspace, 'Edits.md'), '![](attachments/Drawing.excalidraw.svg)\n')
  const svg = await readFile(join(nb.workspace, 'attachments', 'Drawing.excalidraw.svg'), 'utf8')
  expect(svg).toMatch(/^<svg/)
  expect(svg).toContain('payload-type:application/vnd.excalidraw+json')

  const saves = await ipcCalls(nb.app, 'attachment:save')
  await page.locator('.nb-drawing').click()
  await expect(overlay(page).locator('.excalidraw')).toBeVisible()
  await done(page)
  await afterPendingSaves(page)
  expect(await ipcCalls(nb.app, 'attachment:save')).toBe(saves)
  expect(await attachments(nb.workspace)).toEqual(['Drawing.excalidraw.svg'])

  await page.locator('.nb-drawing').click()
  await expect(overlay(page).locator('.excalidraw')).toBeVisible()
  await page.keyboard.press('Meta+a')
  await page.keyboard.press('Delete')
  await drawRectangle(page, 300, 600)
  await done(page)
  await waitForFile(
    join(nb.workspace, 'Edits.md'),
    '![](attachments/Drawing%20\\(2\\).excalidraw.svg)'
  )
  expect((await attachments(nb.workspace)).sort()).toEqual([
    'Drawing (2).excalidraw.svg',
    'Drawing.excalidraw.svg'
  ])
})

test('closing a new drawing without drawing removes its block', async ({ nb }) => {
  const { page } = nb
  await newPage(page, 'Empty')
  await page.keyboard.type('Before')
  await page.keyboard.press('Enter')
  await insertDrawing(page)
  await done(page)
  await expect(page.locator('.bn-block-content[data-content-type="drawing"]')).toHaveCount(0)
  await page.keyboard.type('After')
  await waitForFile(join(nb.workspace, 'Empty.md'), /Before\n\nAfter\n$/)
  expect(await attachments(nb.workspace)).toEqual([])
})

test('Enter opens a selected drawing and Cmd+Enter saves it', async ({ nb }) => {
  const { page } = nb
  await newPage(page, 'Keys')
  await insertDrawing(page)
  await drawRectangle(page, 500, 400)
  await page.keyboard.press('Meta+Enter')
  await expect(overlay(page)).toBeHidden()
  await waitForFile(join(nb.workspace, 'Keys.md'), 'Drawing.excalidraw.svg')
  await expect(page.locator('.nb-block-selected .nb-drawing')).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(overlay(page).locator('.excalidraw')).toBeVisible()
})

test('quitting with the editor open keeps the drawing', async ({ nb }) => {
  await newPage(nb.page, 'Quit')
  await insertDrawing(nb.page)
  await drawRectangle(nb.page, 500, 400)
  const page = await nb.relaunch()
  await expect(page.locator('.nb-drawing img')).toBeVisible()
  expect(await readFile(join(nb.workspace, 'Quit.md'), 'utf8')).toContain(
    '![](attachments/Drawing.excalidraw.svg)'
  )
})

test('the editor follows the app theme, also when it changes while open', async ({ nb }) => {
  const { page } = nb
  await newPage(page, 'Themes')
  await insertDrawing(page)
  await expect(overlay(page)).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  await menu(nb.app, 'Toggle Dark Mode')
  await expect(overlay(page).locator('.excalidraw.theme--dark')).toBeVisible()
  await expect(overlay(page)).toHaveCSS('background-color', 'rgb(18, 18, 18)')
})

test('drawing stays offline and its code loads only when the editor opens', async ({ nb }) => {
  const { page } = nb
  const requests: string[] = []
  page.on('request', (r) => requests.push(r.url()))
  await newPage(page, 'Offline')
  await insertDrawing(page)
  await drawRectangle(page, 500, 400)
  await page.keyboard.press('t')
  await page.mouse.click(520, 600)
  await page.keyboard.type('Hi 你好')
  await page.keyboard.press('Escape')
  await done(page)
  const svg = await waitForFile(
    join(nb.workspace, 'attachments', 'Drawing.excalidraw.svg'),
    'font-family: Xiaolai'
  )
  expect(svg).toContain('font-family: Excalifont')
  expect(requests.filter((u) => !/^(file|data|blob|nbfile):/.test(u))).toEqual([])

  requests.length = 0
  const reopened = await nb.relaunch()
  reopened.on('request', (r) => requests.push(r.url()))
  await reopened.getByTestId('sidebar-row-Offline').click()
  await expect(reopened.locator('.nb-drawing img')).toBeVisible()
  expect(requests.filter((u) => /DrawingEditor|excalidraw\//.test(u))).toEqual([])
})

test('a copied drawing is edited on its own', async ({ nb }) => {
  const { page } = nb
  await newPage(page, 'Copies')
  await insertDrawing(page)
  await drawRectangle(page, 500, 400)
  await done(page)
  await page.keyboard.press('Meta+d')
  await expect(page.locator('.nb-drawing')).toHaveCount(2)
  await page.locator('.nb-drawing').nth(1).click()
  await expect(overlay(page).locator('.excalidraw')).toBeVisible()
  await drawRectangle(page, 300, 600)
  await done(page)
  await waitForFile(
    join(nb.workspace, 'Copies.md'),
    '![](attachments/Drawing.excalidraw.svg)\n\n![](attachments/Drawing%20\\(2\\).excalidraw.svg)\n'
  )
})

test('a drawing in a read-only page does not open', async ({ nbWith }) => {
  const { page } = await openFile(nbWith, 'Old', 'Text\n\n![](attachments/Old.excalidraw.svg)\n', {
    files: drawingFile('Old.excalidraw.svg')
  })
  await expect(page.locator('.nb-drawing')).toHaveCSS('cursor', 'pointer')
  await rowAction(page, 'Old', 'Move to Trash')
  await page.getByRole('button', { name: 'Trash', exact: true }).click()
  await page.getByTestId('trash-item-Old').click()
  await expect(page.getByRole('status')).toContainText('This page is in Trash.')
  await expect(page.locator('.nb-drawing')).toHaveCSS('cursor', 'auto')
  await page.locator('.nb-drawing img').click()
  await expect(overlay(page)).toHaveCount(0)
})

test('a drawing still lands when its page changes on disk while it is open', async ({ nb }) => {
  const { page } = nb
  await newPage(page, 'Outside')
  await insertDrawing(page)
  await drawRectangle(page, 500, 400)
  await done(page)
  const file = join(nb.workspace, 'Outside.md')
  const text = await waitForFile(file, 'Drawing.excalidraw.svg')
  await page.locator('.nb-drawing').click()
  await expect(overlay(page).locator('.excalidraw')).toBeVisible()
  await writeFile(file, `${text}\nTheirs\n`)
  await expect(page.locator('.bn-editor')).toContainText('Theirs')
  await drawRectangle(page, 300, 600)
  await done(page)
  await waitForFile(file, /!\[\]\(attachments\/Drawing%20\\\(2\\\)\.excalidraw\.svg\)\n\nTheirs\n$/)
})

test('a new drawing still lands when its page changes on disk while it is open', async ({ nb }) => {
  const { page } = nb
  await newPage(page, 'Fresh')
  await page.keyboard.type('Before')
  await page.keyboard.press('Enter')
  await insertDrawing(page)
  const file = join(nb.workspace, 'Fresh.md')
  const text = await waitForFile(file, /Before\n$/)
  await writeFile(file, `${text}\nTheirs\n`)
  await expect(page.locator('.bn-editor')).toContainText('Theirs')
  await drawRectangle(page, 500, 400)
  await done(page)
  await waitForFile(file, /Before\n\n!\[\]\(attachments\/Drawing\.excalidraw\.svg\)\n\nTheirs\n$/)
})

test('a new drawing lands in the page of the tab it was made in', async ({ nb }) => {
  const { page, app } = nb
  await newPage(page, 'Other')
  await newPage(page, 'Sketch')
  // A second tab on another page mounts its editor after this one.
  await newTab(app, page)
  await page.getByTestId('sidebar-row-Other').click()
  await expect(activePane(page).getByTestId('page-title')).toHaveText('Other')
  await page.locator('.tab').first().click()
  await expect(activePane(page).getByTestId('page-title')).toHaveText('Sketch')
  await placeCaret(activePane(page).locator('.bn-editor'))
  await insertDrawing(page)
  await drawRectangle(page, 500, 400)
  await done(page)
  await waitForFile(join(nb.workspace, 'Sketch.md'), '![](attachments/Drawing.excalidraw.svg)')
  await afterPendingSaves(page)
  expect(await readFile(join(nb.workspace, 'Other.md'), 'utf8')).not.toContain('excalidraw')
})

test('a drawing that cannot be saved says so over the editor and stays open', async ({ nb }) => {
  const { page } = nb
  await newPage(page, 'Locked')
  await insertDrawing(page)
  await drawRectangle(page, 500, 400)
  const dir = join(nb.workspace, 'attachments')
  await mkdir(dir)
  await chmod(dir, 0o500)
  try {
    await overlay(page).getByRole('button', { name: 'Done' }).click()
    const toast = page.getByRole('alert')
    await expect(toast).toContainText("Couldn't save the drawing")
    const box = (await toast.boundingBox())!
    const topmost = await page.evaluate(
      ([x, y]) => document.elementFromPoint(x, y)?.closest('[role="alert"]') !== null,
      [box.x + box.width / 2, box.y + box.height / 2]
    )
    expect(topmost).toBe(true)
    await expect(overlay(page)).toBeVisible()
  } finally {
    await chmod(dir, 0o755)
  }
  await done(page)
  await waitForFile(join(nb.workspace, 'Locked.md'), 'Drawing.excalidraw.svg')
})

test('a drawing that cannot be read says so and can be closed', async ({ nbWith }) => {
  const { page, workspace } = await openFile(
    nbWith,
    'Unreadable',
    '![](attachments/Secret.excalidraw.svg)\n',
    { files: drawingFile('Secret.excalidraw.svg') }
  )
  const file = join(workspace, 'attachments', 'Secret.excalidraw.svg')
  await expect(page.locator('.nb-drawing img')).toHaveJSProperty('complete', true)
  await chmod(file, 0o000)
  try {
    await page.locator('.nb-drawing').click()
    await expect(overlay(page)).toContainText("Couldn't open the drawing")
    await done(page)
  } finally {
    await chmod(file, 0o644)
  }
})

test('a plain SVG named like a drawing opens as not editable, never overwritten, and with the page under it out of reach', async ({
  nbWith
}) => {
  const { page, app, workspace } = await openFile(
    nbWith,
    'Under',
    'Text\n\n![](attachments/Logo.excalidraw.svg)\n',
    { files: drawingFile('Logo.excalidraw.svg') }
  )
  const styled = await page.evaluate(() =>
    [...document.styleSheets].some((sheet) =>
      [...sheet.cssRules].some((rule) => rule.cssText.startsWith('.drawing-overlay'))
    )
  )
  expect(styled).toBe(true)
  await clickInEditor(page, 'Text')
  await page.keyboard.press('Escape')
  await page.keyboard.press('ArrowDown')
  await expect(page.locator('.nb-block-selected .nb-drawing')).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(overlay(page)).toContainText("This drawing can't be edited")
  await expect(overlay(page).locator('.excalidraw')).toHaveCount(0)
  await expect(overlay(page).getByRole('button', { name: 'Done' })).toBeFocused()
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Tab')
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Escape')
  await expect(overlay(page)).toBeHidden()
  await expect(page.locator('.nb-drawing')).toBeVisible()

  await page.locator('.nb-drawing').click()
  await expect(overlay(page)).toContainText("This drawing can't be edited")
  await done(page)
  await afterPendingSaves(page)
  expect(await ipcCalls(app, 'attachment:save')).toBe(0)
  expect(await attachments(workspace)).toEqual(['Logo.excalidraw.svg'])
  expect(await readFile(join(workspace, 'attachments', 'Logo.excalidraw.svg'), 'utf8')).toBe(SQUARE)
})

test('the drawing editor failing to load shows an error instead of a blank window', async ({
  nb
}) => {
  await nb.app.evaluate(({ session }) => {
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['file://*/*'] }, (req, callback) =>
      callback({ cancel: /\/DrawingEditor-[^/]*\.js$/.test(req.url) })
    )
  })
  const { page } = nb
  await newPage(page, 'Broken')
  await page.keyboard.type('/drawing')
  await page.keyboard.press('Enter')
  await expect(overlay(page)).toContainText("Couldn't open the drawing editor")
  await done(page)
  await expect(page.getByTestId('sidebar-row-Broken')).toBeVisible()
})

test('strokes drawn while a save is running are saved too', async ({ nb }) => {
  const { page, app } = nb
  await newPage(page, 'Busy')
  await insertDrawing(page)
  await drawRectangle(page, 500, 400)
  // Holds every save in the main process until released, counting them.
  await app.evaluate(() => {
    const g = globalThis as { saves?: number; release?: () => void; nbIpc?: IpcProbe }
    let opened: Promise<void> = new Promise((resolve) => (g.release = resolve))
    g.saves = 0
    g.nbIpc!.wrap['attachment:save'] = async () => {
      g.saves! += 1
      await opened
      opened = Promise.resolve()
      return `/attachments/Saved%20${g.saves}.excalidraw.svg`
    }
  })
  await overlay(page).getByRole('button', { name: 'Done' }).click()
  await expect.poll(() => app.evaluate(() => (globalThis as { saves?: number }).saves)).toBe(1)
  // Clicking Done left focus on the button; Excalidraw takes its tool keys only when focused.
  await page.mouse.click(900, 300)
  await drawRectangle(page, 300, 600)
  await app.evaluate(() => (globalThis as { release?: () => void }).release!())
  await expect(overlay(page)).toBeHidden()
  expect(await app.evaluate(() => (globalThis as { saves?: number }).saves)).toBe(2)
  await waitForFile(join(nb.workspace, 'Busy.md'), 'Saved%202.excalidraw.svg')
})
