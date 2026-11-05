import { createServer, type Server } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import { expect, test } from '../e2e/fixtures'
import { stubOpenDialog } from '../e2e/helpers'
import { launchElectron } from '../e2e/launch'

const APP = resolve('dist/mac-arm64/Nobsidian.app/Contents/MacOS/Nobsidian')

test('the packaged app launches to the welcome screen', async ({ tmp }) => {
  const userData = await tmp('user')
  const app = await launchElectron({
    executablePath: APP,
    env: { NOBSIDIAN_USER_DATA: userData }
  })
  const page = await app.firstWindow()
  await expect(page.getByText('Welcome to Nobsidian')).toBeVisible()
  expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true)
})

// "Web" images the export links to are served locally.
let server: Server
test.beforeAll(async () => {
  const png = await readFile(resolve('tests/fixtures/web-image.png'))
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'image/png' })
    res.end(png)
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
})
test.afterAll(() => server.close())

test('the packaged app imports a Notion export in its worker', async ({ tmp }) => {
  const userData = await tmp('user')
  const workspace = await tmp('workspace')
  await writeFile(join(userData, 'settings.json'), JSON.stringify({ lastWorkspace: workspace }))
  const app = await launchElectron({
    executablePath: APP,
    env: {
      NOBSIDIAN_USER_DATA: userData,
      NOBSIDIAN_E2E_WEB: `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    }
  })
  const page = await app.firstWindow()
  await expect(page.getByRole('button', { name: 'Search' })).toBeVisible()
  await stubOpenDialog(app, [resolve('tests/fixtures/notion-export.zip')])
  await app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()!.getMenuItemById('import-notion')!.click()
  )
  await expect(page.getByRole('status')).toContainText('Imported 10 pages. 2 things need a look.')
})

test('the packaged app draws with the fonts it ships', async ({ tmp }) => {
  const userData = await tmp('user')
  const workspace = await tmp('workspace')
  await writeFile(join(workspace, 'Sketch.md'), '\n')
  await writeFile(join(userData, 'settings.json'), JSON.stringify({ lastWorkspace: workspace }))
  const app = await launchElectron({ executablePath: APP, env: { NOBSIDIAN_USER_DATA: userData } })
  const page = await app.firstWindow()
  const requests: string[] = []
  page.on('request', (r) => requests.push(r.url()))
  await page.getByTestId('sidebar-row-Sketch').click()
  await page.locator('.bn-editor').click()
  await page.keyboard.type('/drawing')
  await page.keyboard.press('Enter')
  await expect(page.locator('.excalidraw')).toBeVisible()
  await page.keyboard.press('t')
  await page.mouse.click(500, 400)
  await page.keyboard.type('Hello')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Done' }).click()
  await expect(page.locator('.nb-drawing img')).toBeVisible()
  const svg = await readFile(join(workspace, 'attachments', 'Drawing.excalidraw.svg'), 'utf8')
  expect(svg).toContain('font-family: Excalifont; src: url(data:font/woff2;base64,')
  expect(requests.filter((u) => !/^(file|data|blob|nbfile):/.test(u))).toEqual([])
})
