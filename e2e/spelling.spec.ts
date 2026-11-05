import { join } from 'node:path'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { editor, newPage, waitForFile } from './helpers'

/** Records the right-click menu instead of showing it, as a native menu can't be driven. */
async function captureMenus(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ Menu }) => {
    const g = globalThis as { lastMenu?: Electron.Menu }
    Menu.prototype.popup = function (this: Electron.Menu) {
      g.lastMenu = this
    }
  })
}

async function wordBox(
  block: Locator,
  word: string
): Promise<{ x: number; y: number; width: number; height: number }> {
  return block.evaluate((el, word) => {
    const node = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode()!
    const start = node.textContent!.indexOf(word)
    const range = document.createRange()
    range.setStart(node, start)
    range.setEnd(node, start + word.length)
    const { x, y, width, height } = range.getBoundingClientRect()
    return { x, y, width, height }
  }, word)
}

/** Whether the word is drawn with the red spelling underline, as a user would see it. */
async function underlined(page: Page, block: Locator, word: string): Promise<boolean> {
  const box = await wordBox(block, word)
  const png = await page.screenshot({
    clip: { x: box.x, y: box.y + box.height / 2, width: box.width, height: box.height / 2 + 4 }
  })
  return page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    const image = await createImageBitmap(new Blob([bytes]))
    const context = new OffscreenCanvas(image.width, image.height).getContext('2d')!
    context.drawImage(image, 0, 0)
    const { data } = context.getImageData(0, 0, image.width, image.height)
    for (let i = 0; i < data.length; i += 4)
      if (data[i] > 180 && data[i + 1] < 140 && data[i + 2] < 140) return true
    return false
  }, png.toString('base64'))
}

const menuLabels = (app: ElectronApplication): Promise<string[]> =>
  app.evaluate(() =>
    ((globalThis as { lastMenu?: Electron.Menu }).lastMenu?.items ?? []).map(
      (item) => item.label || item.type
    )
  )

test('right-clicking a misspelled word offers fixes that replace it, a correct one only edit actions', async ({
  nb
}) => {
  const { app, page } = nb
  await captureMenus(app)
  await newPage(page, 'Spelling')
  await page.keyboard.type('Fix this mispeled word ')
  const block = page.locator(`${editor} .bn-inline-content`).first()
  await expect(block).toHaveText('Fix this mispeled word')

  // Right-clicking selects the word, which cancels a spell check that hasn't finished yet.
  await expect
    .poll(() => underlined(page, block, 'mispeled'), {
      message: 'mispeled gets the red underline',
      timeout: 15_000
    })
    .toBe(true)
  expect(await underlined(page, block, 'this')).toBe(false)
  const correct = await wordBox(block, 'this')
  await page.mouse.click(correct.x + correct.width / 2, correct.y + correct.height / 2, {
    button: 'right'
  })
  await expect.poll(() => menuLabels(app)).toEqual(['Cut', 'Copy', 'Paste'])

  const word = await wordBox(block, 'mispeled')
  await page.mouse.click(word.x + word.width / 2, word.y + word.height / 2, { button: 'right' })
  await expect.poll(async () => (await menuLabels(app))[0]).toBe('misspelled')
  expect(await menuLabels(app)).toEqual(
    expect.arrayContaining(['Learn Spelling', 'Cut', 'Copy', 'Paste'])
  )

  await app.evaluate(({ BrowserWindow }) => {
    const menu = (globalThis as { lastMenu?: Electron.Menu }).lastMenu!
    const win = BrowserWindow.getAllWindows()[0]
    menu.items[0].click(undefined, win, win.webContents)
  })
  await expect(block).toHaveText('Fix this misspelled word')
  await waitForFile(join(nb.workspace, 'Spelling.md'), 'Fix this misspelled word')
  await page.keyboard.press('Meta+z')
  await expect(block).toHaveText('Fix this mispeled word')
})
