import { createServer, type Server } from 'node:http'
import { createWriteStream } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { ElectronApplication, Page } from '@playwright/test'
import yazl from 'yazl'
import { expect, test } from './fixtures'
import { editor, newPage, stubOpenDialog, waitForFile } from './helpers'

const FIXTURES = resolve('tests/fixtures')
const EXPORT_ZIP = join(FIXTURES, 'notion-export.zip')
// A whole import (unzip, fetch, write every page) can outrun the default wait on a busy machine.
const IMPORTED = { timeout: 15_000 }

// "Web" images the export links to are served locally; a test can hold the answers back.
let server: Server
let held: Promise<void> | null = null
const webBefore = process.env.NOBSIDIAN_E2E_WEB
test.beforeAll(async () => {
  const png = await readFile(join(FIXTURES, 'web-image.png'))
  server = createServer((_req, res) => {
    void (held ?? Promise.resolve()).then(() => {
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(png)
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  process.env.NOBSIDIAN_E2E_WEB = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
test.afterAll(() => {
  if (webBefore === undefined) delete process.env.NOBSIDIAN_E2E_WEB
  else process.env.NOBSIDIAN_E2E_WEB = webBefore
  server.close()
})

async function importViaMenu(app: ElectronApplication, zips: string[]): Promise<void> {
  // The renderer ignores the command until the workspace has loaded.
  await expect((await app.firstWindow()).getByRole('button', { name: 'Search' })).toBeVisible()
  await stubOpenDialog(app, zips)
  await app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()!.getMenuItemById('import-notion')!.click()
  )
}

test('imports a Notion export with its pages, images, colors and links', async ({ nb }) => {
  const { app, page } = nb
  await importViaMenu(app, [EXPORT_ZIP])
  const panel = page.getByRole('status')
  await expect(panel).toContainText('Imported 10 pages. 2 things need a look.', IMPORTED)
  await panel.getByRole('button', { name: 'Open', exact: true }).click()
  await expect(page.getByTestId('page-title')).toHaveText('Imported from Notion')

  await page.getByTestId('sidebar-row-Nobsidian import fixture').click()
  await expect(page.getByTestId('page-title')).toHaveText('Nobsidian import fixture')
  const body = page.locator(editor)
  await expect(body.getByRole('heading', { name: 'Heading 1', exact: true })).toBeVisible()
  await expect(body.locator('[data-style-type="textColor"][data-value="red"]').first()).toHaveText(
    'red'
  )
  await expect(body.getByText('An orange callout with a custom icon')).toBeVisible()
  await expect(body.getByText('🚧')).toBeVisible()
  const image = body
    .locator('img[alt="An uploaded image with a caption"], .bn-visual-media')
    .first()
  await expect(image).toBeVisible()
  await expect(page.getByTestId('page-cover')).toBeVisible()

  // A page mention leads to the imported page.
  await body.getByRole('link', { name: 'Grandchild page' }).first().click()
  await expect(page.getByTestId('page-title')).toHaveText('Grandchild page')

  const root = join(nb.workspace, 'Imported from Notion')
  expect((await readdir(join(nb.workspace, 'attachments'))).sort()).toEqual([
    'fixture-image.png',
    'fixture-report.pdf',
    'gradients_2.png',
    'gradients_8.png'
  ])
  await waitForFile(join(root, 'Nobsidian import fixture.md'), '> [!callout:orange_bg] 🚧')
  const report = await readFile(join(root, 'Import report.md'), 'utf8')
  expect(report).toContain('## Table formatting not kept (2)')
  expect(await readdir(join(nb.workspace, '.nobsidian'))).not.toContainEqual(
    expect.stringMatching(/^import-/)
  )
})

test('a second import lands next to the first, and a refused drop shows above the panel in a narrow window', async ({
  nb
}) => {
  const { app, page } = nb
  await importViaMenu(app, [EXPORT_ZIP])
  const panel = page.getByRole('status')
  await expect(panel).toContainText('Imported 10 pages', IMPORTED)
  await page.getByRole('button', { name: 'Dismiss' }).click()
  await importViaMenu(app, [EXPORT_ZIP])
  await expect(panel).toContainText('Imported 10 pages', IMPORTED)
  await expect(page.getByTestId('sidebar-row-Imported from Notion')).toBeVisible()
  await expect(page.getByTestId('sidebar-row-Imported from Notion (2)')).toBeVisible()
  await waitForFile(join(nb.workspace, 'Imported from Notion (2).md'), 'id:')
  expect(await readdir(join(nb.workspace, 'attachments'))).toContain('fixture-image (2).png')

  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(720, 600)
  )
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(720)
  const zip = join(nb.userData, 'notes.zip')
  await writeMarkdownExport(zip)
  await dropZip(page, zip)
  const toast = page.getByRole('alert')
  await expect(toast).toContainText('This is a Markdown export. Export again as HTML.')
  await expect(page.getByText('Import this file from Notion?')).toHaveCount(0)
  // The lift follows the panel's height through a ResizeObserver, which reports on the next frame.
  await expect
    .poll(async () => {
      const toastBox = (await toast.boundingBox())!
      const panelBox = (await panel.boundingBox())!
      return panelBox.y - (toastBox.y + toastBox.height)
    })
    .toBeGreaterThanOrEqual(0)
  await expect
    .poll(async () => {
      const toastBox = (await toast.boundingBox())!
      return Math.abs(toastBox.x + toastBox.width / 2 - 360)
    })
    .toBeLessThanOrEqual(1)
})

test('a zip dropped during an import is refused, and cancelling leaves nothing behind', async ({
  nb
}) => {
  const big = join(nb.userData, 'big-export.zip')
  await writeBigExport(big, 1500)
  const { app, page } = nb
  await importViaMenu(app, [big])
  const panel = page.getByRole('status')
  await expect(panel).toContainText('Converting pages')
  await dropZip(page, EXPORT_ZIP)
  await expect(page.getByRole('alert')).toContainText('An import is already running.')
  await expect(page.getByText('Import this file from Notion?')).toHaveCount(0)
  await panel.getByRole('button', { name: 'Cancel' }).click()
  await expect(panel).toContainText('Cancelled, nothing was imported.')
  await expect(page.getByTestId('sidebar-row-Imported from Notion')).toHaveCount(0)
  await expect
    .poll(async () =>
      (await readdir(join(nb.workspace, '.nobsidian')).catch(() => [])).filter((name) =>
        name.startsWith('import-')
      )
    )
    .toEqual([])
})

/** Puts Notion's own copy on the clipboard: its HTML, text and block records as Chromium custom data. */
async function copyFromNotion(
  app: ElectronApplication,
  copy: { records: string; html?: string; text?: string }
): Promise<void> {
  await app.evaluate(
    async ({ clipboard, ClipboardItem }, { html, text, custom }) => {
      const raw = 'electron application/osclipboard;format="org.chromium.web-custom-data"'
      await clipboard.write([
        new ClipboardItem({
          'text/html': html,
          'text/plain': text,
          [raw]: new Blob([Buffer.from(custom, 'base64')])
        })
      ])
    },
    {
      html: copy.html ?? '',
      text: copy.text ?? 'Notion',
      custom: chromiumCustomData({ 'text/_notion-blocks-v3-production': copy.records }).toString(
        'base64'
      )
    }
  )
}

async function paste(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.paste())
}

/**
 * Presses a key that moves the selection and waits for the editor to take the move in: keys
 * pressed faster than it reads the selection are lost.
 */
async function pressMovingSelection(page: Page, key: string): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { moved?: Promise<void> }
    w.moved = new Promise((done) =>
      document.addEventListener('selectionchange', () => requestAnimationFrame(() => done()), {
        once: true
      })
    )
  })
  await page.keyboard.press(key)
  await page.evaluate(() => (window as unknown as { moved: Promise<void> }).moved)
}

async function copyFixtureFromNotion(app: ElectronApplication): Promise<void> {
  await copyFromNotion(app, {
    html: await readFile(join(FIXTURES, 'notion-clipboard', 'page.html'), 'utf8'),
    records: await readFile(join(FIXTURES, 'notion-clipboard', 'records.json'), 'utf8')
  })
}

/** Records for Notion text blocks, one per text. */
function textRecords(...texts: string[]): string {
  return JSON.stringify({
    blocks: texts.map((text, i) => {
      const id = `11111111-2222-4333-8444-55555555555${i}`
      return {
        blockId: id,
        blockSubtree: {
          block: { [id]: { value: { id, type: 'text', properties: { title: [[text]] } } } }
        }
      }
    })
  })
}

test(
  'pasting from Notion keeps colors, callouts and toggles',
  { tag: '@clipboard' },
  async ({ nb }) => {
    const { app, page } = nb
    await newPage(page, 'Pasted')
    await copyFixtureFromNotion(app)
    await paste(app)
    const body = page.locator(editor)
    await expect(body.getByText('An orange callout with a custom icon')).toBeVisible()
    await expect(
      body.locator('[data-style-type="backgroundColor"][data-value="yellow"]').first()
    ).toBeVisible()
    const file = join(nb.workspace, 'Pasted.md')
    const text = await waitForFile(file, '> [!callout:orange_bg] 🚧')
    expect(text).toContain('<details data-heading="1">')
    expect(text).toContain('*Image from Notion: fixture-image.png*')
    await expect(page.getByRole('alert')).toContainText(
      "Images and files uploaded to Notion can't be pasted"
    )
    // The web image is downloaded into attachments/ once it arrives.
    await waitForFile(file, '](attachments/gradients_2.png)')
  }
)

test(
  'a Notion paste stays on its page when the page is left before images arrive',
  { tag: '@clipboard' },
  async ({ nb }) => {
    const { app, page } = nb
    let release!: () => void
    held = new Promise((done) => (release = done))
    try {
      await newPage(page, 'Pasted')
      await copyFixtureFromNotion(app)
      await paste(app)
      await expect(
        page.locator(editor).getByText('An orange callout with a custom icon')
      ).toBeVisible()
      await newPage(page, 'Elsewhere')
    } finally {
      release()
      held = null
    }
    const file = join(nb.workspace, 'Pasted.md')
    const text = await waitForFile(file, '> [!callout:orange_bg] 🚧')
    expect(text).toContain('<details data-heading="1">')
    expect(text).toContain('gradients_2.png')
    await page.getByTestId('sidebar-row-Pasted').click()
    await expect(page.getByTestId('page-title')).toHaveText('Pasted')
    await expect(
      page.locator(editor).getByText('An orange callout with a custom icon')
    ).toBeVisible()
  }
)

test(
  'a Notion paste goes into the sentence at the cursor, or replaces the selected text',
  { tag: '@clipboard' },
  async ({ nb }) => {
    const { app, page } = nb
    const file = join(nb.workspace, 'Phrase.md')
    await newPage(page, 'Phrase')
    await page.keyboard.type('Hello world')
    // Saved means the editor has taken the typing in, so the next keys are not lost.
    await waitForFile(file, 'Hello world')
    for (let i = 0; i < 'world'.length; i++) await pressMovingSelection(page, 'ArrowLeft')
    await copyFromNotion(app, {
      records: textRecords('pasted words'),
      html: '<!-- notionvc: 1 --><p>pasted words</p>',
      text: 'pasted words'
    })
    await paste(app)
    const blocks = page.locator(`${editor} .bn-block-content`)
    await expect(blocks).toHaveText(['Hello pasted wordsworld'])
    await waitForFile(file, 'Hello pasted wordsworld')

    for (let i = 0; i < 'world'.length; i++) await pressMovingSelection(page, 'Shift+ArrowRight')
    await copyFromNotion(app, { records: textRecords('X'), text: 'X' })
    await paste(app)
    await expect(blocks).toHaveText(['Hello pasted wordsX'])
    await pressMovingSelection(page, 'Shift+ArrowLeft')
    await pressMovingSelection(page, 'Shift+ArrowLeft')
    await copyFromNotion(app, { records: textRecords('One', 'Two'), text: 'One\nTwo' })
    await paste(app)
    await expect(blocks).toHaveText(['Hello pasted word', 'One', 'Two'])
  }
)

test(
  'a Notion paste into a code block is pasted as plain text',
  { tag: '@clipboard' },
  async ({ nb }) => {
    const { app, page } = nb
    await newPage(page, 'Code')
    await page.keyboard.type('``` ')
    await expect(page.locator(`${editor} [data-content-type="codeBlock"]`)).toBeVisible()
    await copyFromNotion(app, { records: textRecords('x = 1'), text: 'x = 1\ny = 2' })
    await paste(app)
    await expect(page.locator(`${editor} [data-content-type="codeBlock"] code`)).toHaveText(
      'x = 1\ny = 2'
    )
    await expect(page.locator(`${editor} .bn-block-content`)).toHaveCount(1)
  }
)

test(
  'a Notion paste into a table cell is pasted as plain text',
  { tag: '@clipboard' },
  async ({ nb }) => {
    const { app, page } = nb
    await newPage(page, 'Table')
    await page.keyboard.type('/table')
    await page.keyboard.press('Enter')
    const table = page.locator(`${editor} [data-content-type="table"]`)
    await expect(table).toBeVisible()
    await copyFromNotion(app, { records: textRecords('One', 'Two'), text: 'One\nTwo' })
    await paste(app)
    await expect(table.locator('td, th').first()).toHaveText('OneTwo')
    await expect(page.locator(`${editor} .bn-block-content`)).toHaveCount(1)
  }
)

/** Chromium's clipboard format for custom MIME types: a pickle of UTF-16 type/value pairs. */
function chromiumCustomData(entries: Record<string, string>): Buffer {
  const parts: Buffer[] = []
  const u32 = (n: number): Buffer => {
    const b = Buffer.alloc(4)
    b.writeUInt32LE(n)
    return b
  }
  const string16 = (s: string): Buffer => {
    const data = Buffer.from(s, 'utf16le')
    const pad = (4 - (data.length % 4)) % 4
    return Buffer.concat([u32(s.length), data, Buffer.alloc(pad)])
  }
  parts.push(u32(Object.keys(entries).length))
  for (const [type, value] of Object.entries(entries)) parts.push(string16(type), string16(value))
  const payload = Buffer.concat(parts)
  return Buffer.concat([u32(payload.length), payload])
}

test('dropping a Notion export on the window asks, then imports it', async ({ nb }) => {
  const { page } = nb
  await expect(page.getByRole('button', { name: 'Search' })).toBeVisible()
  await dropZip(page, EXPORT_ZIP)
  await expect(page.getByText('Import this file from Notion?')).toBeVisible()
  await page.getByRole('button', { name: 'Import', exact: true }).click()
  await expect(page.getByRole('status')).toContainText('Imported 10 pages', IMPORTED)
})

test('an export-named zip dropped in a page that is not one is attached as a file', async ({
  nb
}) => {
  const { page } = nb
  await newPage(page, 'Drops')
  await dropZip(page, 'Export-1.zip', editor)
  await expect(page.locator(editor).getByText('Export-1.zip')).toBeVisible()
  await expect(page.getByText('Import this file from Notion?')).toHaveCount(0)
})

async function dropZip(page: Page, path: string, target = 'body'): Promise<void> {
  await page.evaluate(
    ({ path, target }) => {
      const transfer = new DataTransfer()
      transfer.items.add(
        new File([new Uint8Array([80, 75, 5, 6])], path, { type: 'application/zip' })
      )
      const el = document.querySelector(target)!
      el.dispatchEvent(
        new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true })
      )
    },
    { path, target }
  )
}

async function writeMarkdownExport(path: string): Promise<void> {
  const out = new yazl.ZipFile()
  out.addBuffer(Buffer.from('# Notes\n'), 'Notes 0123456789abcdef0123456789abcdef.md')
  out.end()
  await pipeline(out.outputStream, createWriteStream(path))
}

async function writeBigExport(path: string, pages: number): Promise<void> {
  const zip = new yazl.ZipFile()
  const paragraph = `<p>${'Some words in a long paragraph. '.repeat(40)}</p>`.repeat(30)
  for (let i = 0; i < pages; i++) {
    const id = i.toString(16).padStart(32, '0')
    const html =
      `<html><body><article class="page"><header><h1 class="page-title">Page ${i}</h1></header>` +
      `<div class="page-body">${paragraph}</div></article></body></html>`
    zip.addBuffer(Buffer.from(html), `Private & Shared/Page ${i} ${id}.html`)
  }
  zip.end()
  await pipeline(zip.outputStream, createWriteStream(path))
}
