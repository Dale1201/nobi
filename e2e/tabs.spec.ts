import { chmod, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import type { IpcProbe } from '../src/main/ipc'
import { expect, test, type AppFixture, type Seed } from './fixtures'
import {
  accelerators,
  activePane,
  caretToLineEnd,
  editor,
  frontmatter,
  menu,
  newTab,
  placeCaret,
  rowAction,
  stubOpenDialog,
  waitForFile
} from './helpers'

const tabTitles = (page: Page): Promise<(string | null)[]> =>
  page.locator('.tab').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))
const activeTitle = (page: Page): Promise<string | null> =>
  page.locator('.tab.active').getAttribute('aria-label')

function pages(
  nbWith: (seed: Seed) => Promise<AppFixture>,
  files: Record<string, string>
): Promise<AppFixture> {
  return nbWith({
    files: Object.fromEntries(Object.entries(files).map(([name, body]) => [`${name}.md`, body]))
  })
}

async function open(page: Page, title: string): Promise<void> {
  await page.getByTestId(`sidebar-row-${title}`).click()
  await expect(activePane(page).getByTestId('page-title')).toHaveText(title)
}

/** Opens a page in a new tab without modifier clicks: a new tab, then the page in it. */
async function tabOn(app: ElectronApplication, page: Page, title: string): Promise<void> {
  await newTab(app, page)
  await open(page, title)
}

const long = Array.from({ length: 80 }, (_, i) => `Paragraph ${i + 1}.`).join('\n\n') + '\n'

const scrollTop = (page: Page): Promise<number> =>
  activePane(page)
    .getByTestId('page-scroll')
    .evaluate((el) => el.scrollTop)

test('Cmd+T and + open the current page in a new tab right after it', async ({ nbWith }) => {
  const nb = await pages(nbWith, { Alpha: 'A.\n', Beta: 'B.\n' })
  const { page } = nb
  await open(page, 'Alpha')
  await newTab(nb.app, page)
  await expect.poll(() => tabTitles(page)).toEqual(['Alpha', 'Alpha'])
  await expect(page.locator('.tab').nth(1)).toHaveClass(/active/)
  await open(page, 'Beta')
  await page.locator('.tab').first().click()
  await page.getByRole('button', { name: 'New tab' }).click()
  await expect.poll(() => tabTitles(page)).toEqual(['Alpha', 'Alpha', 'Beta'])
  await expect.poll(() => activeTitle(page)).toBe('Alpha')
  await expect(page.locator('.tab').nth(1)).toHaveClass(/active/)
})

test('closing tabs hands over to a neighbour, and closing the last one closes the window', async ({
  nbWith
}) => {
  const nb = await pages(nbWith, { One: '1\n', Two: '2\n', Three: '3\n' })
  const { page } = nb
  await open(page, 'One')
  await tabOn(nb.app, page, 'Two')
  await tabOn(nb.app, page, 'Three')
  await page.getByTestId('tab-Two').click({ button: 'middle' })
  await expect.poll(() => tabTitles(page)).toEqual(['One', 'Three'])
  await page.getByTestId('tab-One').hover()
  await page.getByRole('button', { name: 'Close One' }).click()
  await expect.poll(() => tabTitles(page)).toEqual(['Three'])
  await expect(activePane(page).getByTestId('page-title')).toHaveText('Three')
  await menu(nb.app, 'Close Tab')
  await expect
    .poll(() => nb.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length))
    .toBe(0)
})

test('the tab shortcuts switch tabs', async ({ nbWith }) => {
  const nb = await pages(nbWith, { One: '1\n', Two: '2\n', Three: '3\n' })
  const { page } = nb
  await open(page, 'One')
  await tabOn(nb.app, page, 'Two')
  await tabOn(nb.app, page, 'Three')
  expect(await accelerators(nb.app)).toMatchObject({
    'New Tab': 'CmdOrCtrl+T',
    'Close Tab': 'CmdOrCtrl+W',
    'Close Window': 'CmdOrCtrl+Shift+W',
    'Reopen Closed Tab': 'CmdOrCtrl+Shift+T',
    'Show Next Tab': 'Ctrl+Tab',
    'Show Previous Tab': 'Ctrl+Shift+Tab',
    'Select Tab 1': 'CmdOrCtrl+1',
    'Select Last Tab': 'CmdOrCtrl+9'
  })
  await menu(nb.app, 'Show Next Tab')
  await expect.poll(() => activeTitle(page)).toBe('One')
  await menu(nb.app, 'Alt+CmdOrCtrl+Right')
  await expect.poll(() => activeTitle(page)).toBe('Two')
  await menu(nb.app, 'CmdOrCtrl+Shift+[')
  await expect.poll(() => activeTitle(page)).toBe('One')
  await menu(nb.app, 'Show Previous Tab')
  await expect.poll(() => activeTitle(page)).toBe('Three')
  await menu(nb.app, 'Select Tab 2')
  await expect.poll(() => activeTitle(page)).toBe('Two')
  await menu(nb.app, 'Select Last Tab')
  await expect.poll(() => activeTitle(page)).toBe('Three')
})

test('each tab keeps its own back and forward, with scroll positions', async ({ nbWith }) => {
  const nb = await pages(nbWith, { Long: long, Short: 'Short.\n' })
  const { page } = nb
  await open(page, 'Long')
  await activePane(page)
    .getByTestId('page-scroll')
    .evaluate((el) => (el.scrollTop = 700))
  await open(page, 'Short')
  await page.getByRole('button', { name: 'Back' }).click()
  await expect(activePane(page).getByTestId('page-title')).toHaveText('Long')
  await expect.poll(() => scrollTop(page)).toBe(700)
  await expect(page.getByRole('button', { name: 'Forward' })).toBeEnabled()
  await newTab(nb.app, page)
  await expect(activePane(page).getByTestId('page-title')).toHaveText('Long')
  await expect(page.getByRole('button', { name: 'Back' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Forward' })).toBeDisabled()
  await page.locator('.tab').first().click()
  await page.getByRole('button', { name: 'Forward' }).click()
  await expect(activePane(page).getByTestId('page-title')).toHaveText('Short')
})

test("the mouse's back and forward buttons move through the tab's history", async ({ nbWith }) => {
  const nb = await pages(nbWith, { First: 'First.\n', Second: 'Second.\n' })
  const { page } = nb
  await open(page, 'First')
  await open(page, 'Second')
  const cdp = await page.context().newCDPSession(page)
  const press = async (button: 'back' | 'forward'): Promise<void> => {
    const at = { x: 600, y: 300, button, clickCount: 1 }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at })
  }
  await press('back')
  await expect(activePane(page).getByTestId('page-title')).toHaveText('First')
  await press('forward')
  await expect(activePane(page).getByTestId('page-title')).toHaveText('Second')
})

test('a tab left and come back to keeps its scroll and its undo history', async ({ nbWith }) => {
  const nb = await pages(nbWith, { Long: long, Other: 'Other.\n' })
  const { page } = nb
  await open(page, 'Long')
  await placeCaret(activePane(page).locator(editor).getByText('Paragraph 3.'))
  await caretToLineEnd(page)
  await page.keyboard.type(' typed')
  await activePane(page)
    .getByTestId('page-scroll')
    .evaluate((el) => (el.scrollTop = 500))
  await tabOn(nb.app, page, 'Other')
  await waitForFile(join(nb.workspace, 'Long.md'), 'Paragraph 3. typed')
  await page.getByTestId('tab-Long').click()
  await expect.poll(() => scrollTop(page)).toBe(500)
  await placeCaret(activePane(page).locator(editor).getByText('Paragraph 3. typed'))
  await page.keyboard.press('Meta+Z')
  await expect(activePane(page).locator(editor)).not.toContainText('typed')
})

test('a renamed page renames its tabs', async ({ nbWith }) => {
  const nb = await pages(nbWith, { Draft: 'Text.\n', Other: 'Other.\n' })
  const { page } = nb
  await open(page, 'Draft')
  await tabOn(nb.app, page, 'Other')
  await rowAction(page, 'Draft', 'Rename')
  await page.keyboard.press('Meta+A')
  await page.keyboard.type('Final')
  await page.keyboard.press('Enter')
  await expect.poll(() => tabTitles(page)).toEqual(['Final', 'Other'])
  const file = join(nb.workspace, 'Other.md')
  await writeFile(
    file,
    (await frontmatter(file)).replace('---\n', '---\nicon: 🌿\n') + '\nOther.\n'
  )
  await expect(page.getByTestId('tab-Other').locator('.tab-icon')).toHaveText('🌿')
})

test('a deleted page shows the Trash banner in its tabs and comes back when restored', async ({
  nbWith
}) => {
  const nb = await pages(nbWith, { Doomed: 'Keep me.\n', Other: 'Other.\n' })
  const { page } = nb
  await open(page, 'Doomed')
  await newTab(nb.app, page)
  await rowAction(page, 'Doomed', 'Move to Trash')
  await expect(activePane(page).getByRole('status')).toContainText('This page is in Trash.')
  await expect.poll(() => tabTitles(page)).toEqual(['Doomed', 'Doomed'])
  await page.locator('.tab').first().click()
  await expect(activePane(page).getByRole('status')).toContainText('This page is in Trash.')
  await activePane(page).getByRole('button', { name: 'Restore page' }).click()
  await expect(activePane(page).locator(editor)).toContainText('Keep me.')
  await page.locator('.tab').nth(1).click()
  await expect(activePane(page).locator(editor)).toContainText('Keep me.')
})

test('a page deleted outside the app sends its tab back to the previous page', async ({
  nbWith
}) => {
  const nb = await pages(nbWith, { First: '1\n', Second: '2\n' })
  const { page } = nb
  await open(page, 'First')
  await open(page, 'Second')
  await unlink(join(nb.workspace, 'Second.md'))
  await expect(activePane(page).getByTestId('page-title')).toHaveText('First')
  await expect.poll(() => tabTitles(page)).toEqual(['First'])
})

test('an outside edit reloads a hidden tab quietly', async ({ nbWith }) => {
  const nb = await pages(nbWith, { Shown: 'Shown.\n', Hidden: 'Before.\n' })
  const { page } = nb
  await open(page, 'Hidden')
  await tabOn(nb.app, page, 'Shown')
  const file = join(nb.workspace, 'Hidden.md')
  await writeFile(file, `${await frontmatter(file)}\nAfter.\n`)
  await expect(page.locator('.tab-pane:not(.active)').locator(editor)).toHaveText('After.')
  await page.getByTestId('tab-Hidden').click()
  await expect(activePane(page).locator(editor)).toHaveText('After.')
  await expect(activePane(page).getByRole('status')).toHaveCount(0)
})

test('closing a tab saves what was typed in it, the last one before the window closes', async ({
  nbWith
}) => {
  const nb = await pages(nbWith, { Alpha: 'A.\n', Beta: 'B.\n' })
  const { page } = nb
  await open(page, 'Alpha')
  await tabOn(nb.app, page, 'Beta')
  await placeCaret(activePane(page).locator(editor).getByText('B.'))
  await caretToLineEnd(page)
  await page.keyboard.type(' Last words.')
  await menu(nb.app, 'Close Tab')
  await expect.poll(() => tabTitles(page)).toEqual(['Alpha'])
  await waitForFile(join(nb.workspace, 'Beta.md'), 'B. Last words.')

  await placeCaret(activePane(page).locator(editor).getByText('A.'))
  await caretToLineEnd(page)
  await page.keyboard.type(' Final words.')
  await menu(nb.app, 'Close Tab')
  await waitForFile(join(nb.workspace, 'Alpha.md'), 'A. Final words.')
  await expect
    .poll(() => nb.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length))
    .toBe(0)
})

test('tabs come back after a relaunch, for each notes folder', async ({ nbWith, tmp }) => {
  const nb = await pages(nbWith, { One: '1\n', Two: '2\n', Three: '3\n' })
  let page = nb.page
  await open(page, 'One')
  await open(page, 'Two')
  await tabOn(nb.app, page, 'Three')
  page = await nb.relaunch()
  await expect.poll(() => tabTitles(page)).toEqual(['Two', 'Three'])
  await expect.poll(() => activeTitle(page)).toBe('Three')
  await page.getByTestId('tab-Two').click()
  await page.getByRole('button', { name: 'Back' }).click()
  await expect(activePane(page).getByTestId('page-title')).toHaveText('One')

  const other = await tmp('other')
  // With an id the page is known at once, instead of after new files settle.
  await writeFile(
    join(other, 'Elsewhere.md'),
    '---\nid: 33333333-3333-4333-8333-333333333333\n---\n\nElsewhere.\n'
  )
  await stubOpenDialog(nb.app, [other])
  await page.locator('.sidebar-workspace').click()
  await page.getByText('Open another folder…').click()
  await expect.poll(() => tabTitles(page)).toEqual(['Elsewhere'])
  await stubOpenDialog(nb.app, [nb.workspace])
  await page.locator('.sidebar-workspace').click()
  await page.getByText('Open another folder…').click()
  await expect.poll(() => tabTitles(page)).toEqual(['One', 'Three'])
})

test('a file dropped on a page is attached to the visible tab only', async ({ nbWith }) => {
  const nb = await pages(nbWith, { Alpha: 'A.\n', Beta: 'B.\n' })
  const { page } = nb
  await open(page, 'Alpha')
  await tabOn(nb.app, page, 'Beta')
  // A zip named like a Notion export, dropped in a page, is attached once it turns out not to be one.
  await page.evaluate(() => {
    const transfer = new DataTransfer()
    transfer.items.add(
      new File([new Uint8Array([80, 75, 5, 6])], 'Export-1.zip', { type: 'application/zip' })
    )
    document
      .querySelector('.tab-pane.active .bn-editor')!
      .dispatchEvent(
        new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true })
      )
  })
  await expect(activePane(page).locator(editor).getByText('Export-1.zip')).toBeVisible()
  await page.getByTestId('tab-Alpha').click()
  await expect(activePane(page).locator(editor)).toHaveText('A.')
})

test('tabs squeezed to 36px show only their icon, centred, and the active one stays in view', async ({
  nbWith
}) => {
  const nb = await pages(nbWith, { Alpha: '---\nicon: 🚀\n---\n\nA.\n' })
  const { page } = nb
  await open(page, 'Alpha')
  for (let i = 0; i < 30; i++) await newTab(nb.app, page)
  await expect(page.locator('.tab')).toHaveCount(31)
  const active = page.locator('.tab.active')
  await expect.poll(async () => (await active.boundingBox())?.width).toBe(36)
  await expect
    .poll(async () => {
      const tab = (await active.boundingBox())!
      const icon = (await active.locator('.tab-icon').boundingBox())!
      return Math.abs(icon.x + icon.width / 2 - (tab.x + tab.width / 2))
    })
    .toBeLessThanOrEqual(0.5)
  await expect(active.locator('.tab-title')).toBeHidden()
  const inView = async (): Promise<boolean> => {
    const list = (await page.locator('.tab-list').boundingBox())!
    const tab = (await active.boundingBox())!
    return tab.x >= list.x - 0.5 && tab.x + tab.width <= list.x + list.width + 0.5
  }
  await expect.poll(inView).toBe(true)
  await menu(nb.app, 'Select Tab 1')
  await expect.poll(inView).toBe(true)
  await menu(nb.app, 'Select Last Tab')
  await expect.poll(inView).toBe(true)
})

test('Cmd-click and middle-click open background tabs in a row; Cmd+Shift-click opens in front', async ({
  nbWith
}) => {
  const nb = await pages(nbWith, { One: '1\n', Two: '2\n', Three: '3\n', Four: '4\n' })
  const { page } = nb
  await open(page, 'One')
  await page.getByTestId('sidebar-row-Two').click({ modifiers: ['Meta'] })
  await page.getByTestId('sidebar-row-Three').click({ button: 'middle' })
  await expect.poll(() => tabTitles(page)).toEqual(['One', 'Two', 'Three'])
  await expect.poll(() => activeTitle(page)).toBe('One')
  await expect(activePane(page).getByTestId('page-title')).toHaveText('One')
  await page.getByTestId('sidebar-row-Four').click({ modifiers: ['Meta', 'Shift'] })
  await expect.poll(() => tabTitles(page)).toEqual(['One', 'Two', 'Three', 'Four'])
  await expect.poll(() => activeTitle(page)).toBe('Four')
  await expect(activePane(page).getByTestId('page-title')).toHaveText('Four')
})

test('links and mentions open in a background tab with Cmd or the middle button, in front with Cmd+Shift', async ({
  nbWith
}) => {
  const nb = await pages(nbWith, {
    Hub: 'Read [the plan](Plan.md) and [Notes](Notes.md "mention").\n',
    Plan: 'Plan.\n',
    Notes: 'Notes.\n'
  })
  const { page } = nb
  await open(page, 'Hub')
  await activePane(page)
    .locator(editor)
    .getByRole('link', { name: 'the plan' })
    .click({ modifiers: ['Meta'] })
  await activePane(page).locator('.nb-mention').click({ button: 'middle' })
  await expect.poll(() => tabTitles(page)).toEqual(['Hub', 'Plan', 'Notes'])
  await expect.poll(() => activeTitle(page)).toBe('Hub')
  await activePane(page)
    .locator(editor)
    .getByRole('link', { name: 'the plan' })
    .click({ modifiers: ['Meta', 'Shift'] })
  await expect.poll(() => tabTitles(page)).toEqual(['Hub', 'Plan', 'Notes', 'Plan'])
  await expect(page.locator('.tab').nth(3)).toHaveClass(/active/)
  await expect(activePane(page).getByTestId('page-title')).toHaveText('Plan')
  // A plain click still opens the page in the tab it is in.
  await page.locator('.tab').first().click()
  await activePane(page).locator('.nb-mention').click()
  await expect.poll(() => tabTitles(page)).toEqual(['Notes', 'Plan', 'Notes', 'Plan'])
})

test('Cmd+Enter in Search opens the result in a background tab', async ({ nbWith }) => {
  const nb = await pages(nbWith, { Alpha: 'A.\n', Beta: 'Findable words.\n' })
  const { page } = nb
  await open(page, 'Alpha')
  await page.keyboard.press('Meta+K')
  await page.getByPlaceholder(/^Search/).fill('Findable')
  await expect(page.locator('.search-item')).toHaveCount(1)
  await page.keyboard.press('Meta+Enter')
  await expect.poll(() => tabTitles(page)).toEqual(['Alpha', 'Beta'])
  await expect.poll(() => activeTitle(page)).toBe('Alpha')
})

test('Reopen Closed Tab brings back a closed tab, and a batch closed together', async ({
  nbWith
}) => {
  const nb = await pages(nbWith, { One: '1\n', Two: '2\n', Three: '3\n' })
  const { page } = nb
  await open(page, 'One')
  await page.getByTestId('sidebar-row-Two').click({ modifiers: ['Meta'] })
  await page.getByTestId('sidebar-row-Three').click({ modifiers: ['Meta'] })
  await page.getByTestId('tab-Two').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Close Other Tabs' }).click()
  await expect.poll(() => tabTitles(page)).toEqual(['Two'])
  await menu(nb.app, 'Reopen Closed Tab')
  await expect.poll(() => tabTitles(page)).toEqual(['One', 'Two', 'Three'])

  await page.getByTestId('tab-Three').click({ button: 'middle' })
  await page.getByTestId('tab-One').click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Reopen Closed Tab' }).click()
  await expect.poll(() => tabTitles(page)).toEqual(['One', 'Two', 'Three'])
  await expect.poll(() => activeTitle(page)).toBe('Three')
})

test('the tab menu disables what would do nothing', async ({ nbWith }) => {
  const nb = await pages(nbWith, { One: '1\n', Two: '2\n' })
  const { page } = nb
  await open(page, 'One')
  await page.getByTestId('tab-One').click({ button: 'right' })
  for (const label of ['Reopen Closed Tab', 'Close Other Tabs', 'Close Tabs to the Left']) {
    await expect(page.getByRole('menuitem', { name: label })).toHaveAttribute(
      'aria-disabled',
      'true'
    )
  }
  await page.getByRole('menuitem', { name: 'Duplicate Tab' }).click()
  await expect.poll(() => tabTitles(page)).toEqual(['One', 'One'])
})

test('dragging a tab moves it', async ({ nbWith }) => {
  const nb = await pages(nbWith, { One: '1\n', Two: '2\n', Three: '3\n' })
  const { page } = nb
  await open(page, 'One')
  await page.getByTestId('sidebar-row-Two').click({ modifiers: ['Meta'] })
  await page.getByTestId('sidebar-row-Three').click({ modifiers: ['Meta'] })
  await expect.poll(() => tabTitles(page)).toEqual(['One', 'Two', 'Three'])
  const one = await page.getByTestId('tab-One').boundingBox()
  const three = await page.getByTestId('tab-Three').boundingBox()
  await page.mouse.move(one!.x + 20, one!.y + 18)
  await page.mouse.down()
  await page.mouse.move(one!.x + 40, one!.y + 18, { steps: 4 })
  await expect(page.locator('.tab-drop-line')).toBeVisible()
  await page.mouse.move(three!.x + three!.width - 10, three!.y + 18, { steps: 8 })
  await page.mouse.up()
  await expect.poll(() => tabTitles(page)).toEqual(['Two', 'Three', 'One'])
  await expect.poll(() => activeTitle(page)).toBe('One')
  await expect(page.locator('.tab-drop-line')).toHaveCount(0)
})

test('a hidden tab whose page is in conflict shows a dot until it is looked at', async ({
  nbWith
}) => {
  const nb = await pages(nbWith, { Shared: 'Base\n', Other: 'Other.\n' })
  const { page } = nb
  await open(page, 'Shared')
  const file = join(nb.workspace, 'Shared.md')
  const head = await frontmatter(file)
  await placeCaret(activePane(page).locator(editor).getByText('Base'))
  await caretToLineEnd(page)
  await page.keyboard.type(' plus mine')
  await writeFile(file, `${head}\nTheirs\n`)
  await expect(activePane(page).getByRole('status')).toContainText('changed outside Nobsidian')
  await page.getByTestId('sidebar-row-Other').click({ modifiers: ['Meta', 'Shift'] })
  await expect(page.getByTestId('tab-Shared').locator('.tab-conflict')).toBeVisible()
  await page.getByTestId('tab-Shared').click()
  await expect(activePane(page).getByRole('status')).toContainText('changed outside Nobsidian')
  await expect(page.locator('.tab-conflict')).toHaveCount(0)
  await expect(activePane(page).locator(editor)).toHaveText('Base plus mine')
})

test('typing in one tab updates the same page in another, in place and with one history version', async ({
  nbWith
}) => {
  const nb = await pages(nbWith, { Shared: 'Start.\n' })
  const { page } = nb
  await open(page, 'Shared')
  await newTab(nb.app, page)
  await placeCaret(activePane(page).locator(editor).getByText('Start.'))
  await caretToLineEnd(page)
  const file = join(nb.workspace, 'Shared.md')
  // Each word is its own save, so the other tab takes in several saves of this one.
  let text = 'Start.'
  for (const word of [' one', ' two', ' three']) {
    await page.keyboard.type(word)
    text += word
    await waitForFile(file, text)
  }
  await page.locator('.tab').first().click()
  await expect(activePane(page).locator(editor)).toHaveText(text)
  await expect(activePane(page).getByRole('status')).toHaveCount(0)
  const id = /id: (\S+)/.exec(await readFile(file, 'utf8'))![1]
  const versions = await readdir(join(nb.workspace, '.nobsidian', 'history', id)).catch(() => [])
  expect(versions.filter((v) => v.endsWith('.md')).length).toBeLessThanOrEqual(1)
  await placeCaret(activePane(page).locator(editor).getByText(text))
  await caretToLineEnd(page)
  await page.keyboard.type(' four')
  await expect(activePane(page).locator(editor)).toHaveText(`${text} four`)
})

test('moving a tab keeps the scroll position of a hidden tab', async ({ nbWith }) => {
  const nb = await pages(nbWith, { Long: long, Short: 'Short.\n' })
  const { page } = nb
  await open(page, 'Long')
  await activePane(page)
    .getByTestId('page-scroll')
    .evaluate((el) => (el.scrollTop = 700))
  await page.getByTestId('sidebar-row-Short').click({ modifiers: ['Meta', 'Shift'] })
  await expect(activePane(page).getByTestId('page-title')).toHaveText('Short')
  const short = (await page.getByTestId('tab-Short').boundingBox())!
  const longTab = (await page.getByTestId('tab-Long').boundingBox())!
  await page.mouse.move(short.x + 20, short.y + 18)
  await page.mouse.down()
  await page.mouse.move(short.x - 10, short.y + 18, { steps: 4 })
  await page.mouse.move(longTab.x + 5, longTab.y + 18, { steps: 8 })
  await page.mouse.up()
  await expect.poll(() => tabTitles(page)).toEqual(['Short', 'Long'])
  await page.getByTestId('tab-Long').click()
  await expect.poll(() => scrollTop(page)).toBe(700)
})

test('reopening a tab whose page was deleted since shows the Trash banner or steps away', async ({
  nbWith
}) => {
  const nb = await pages(nbWith, { Keep: 'Keep.\n', Doomed: 'Doomed.\n', Gone: 'Gone.\n' })
  const { page } = nb
  await open(page, 'Keep')
  await tabOn(nb.app, page, 'Doomed')
  await menu(nb.app, 'Close Tab')
  await expect(page.locator('.tab')).toHaveCount(1)
  await rowAction(page, 'Doomed', 'Move to Trash')
  await expect(page.getByTestId('sidebar-row-Doomed')).toHaveCount(0)
  await menu(nb.app, 'Reopen Closed Tab')
  await expect.poll(() => tabTitles(page)).toEqual(['Keep', 'Doomed'])
  await expect(activePane(page).getByRole('status')).toContainText('This page is in Trash.')

  // Deleted outside the app, it steps back to the page the tab showed before.
  await page.getByTestId('tab-Keep').click()
  await tabOn(nb.app, page, 'Gone')
  await menu(nb.app, 'Close Tab')
  await expect(page.locator('.tab')).toHaveCount(2)
  await unlink(join(nb.workspace, 'Gone.md'))
  await expect(page.getByTestId('sidebar-row-Gone')).toHaveCount(0)
  await menu(nb.app, 'Reopen Closed Tab')
  await expect.poll(() => tabTitles(page)).toEqual(['Keep', 'Keep', 'Doomed'])
  await expect(activePane(page).getByTestId('page-title')).toHaveText('Keep')
})

test('Cmd+K opens Search after leaving a tab with selected text', async ({ nbWith }) => {
  const nb = await pages(nbWith, { Alpha: 'Some words here.\n', Beta: 'B.\n' })
  const { page } = nb
  await open(page, 'Alpha')
  await activePane(page).locator(editor).getByText('Some words here.').dblclick()
  await page.getByTestId('sidebar-row-Beta').click({ modifiers: ['Meta', 'Shift'] })
  await expect(activePane(page).getByTestId('page-title')).toHaveText('Beta')
  await page.keyboard.press('Meta+K')
  await expect(page.getByRole('dialog', { name: 'Search' })).toBeVisible()
})

test('coming back to a tab puts the caret back where it was', async ({ nbWith }) => {
  const nb = await pages(nbWith, { Alpha: 'A.\n', Beta: 'B.\n' })
  const { page } = nb
  await open(page, 'Alpha')
  await tabOn(nb.app, page, 'Beta')
  await page.locator('.tab').first().click()
  await placeCaret(activePane(page).locator(editor).getByText('A.'))
  await caretToLineEnd(page)
  await menu(nb.app, 'Show Next Tab')
  await expect(activePane(page).getByTestId('page-title')).toHaveText('Beta')
  await menu(nb.app, 'Show Previous Tab')
  await expect(activePane(page).getByTestId('page-title')).toHaveText('Alpha')
  await page.keyboard.type(' typed')
  await expect(activePane(page).locator(editor)).toHaveText('A. typed')
})

test('a new tab opened while the page is still saving shows the saved text, and keeps it', async ({
  nbWith
}) => {
  const nb = await pages(nbWith, { Shared: 'Start.\n' })
  const { page } = nb
  await open(page, 'Shared')
  // The new tab's read takes the page's text, the held-back save lands, then the read answers.
  await nb.app.evaluate(() => {
    const ipc = (globalThis as { nbIpc?: IpcProbe }).nbIpc!
    let readTaken!: () => void
    let saved!: () => void
    const taken = new Promise<void>((r) => (readTaken = r))
    const written = new Promise<void>((r) => (saved = r))
    ipc.wrap['page:write'] = async (call) => {
      await taken
      try {
        return await call()
      } finally {
        saved()
      }
    }
    let first = true
    ipc.wrap['page:read'] = async (call) => {
      const doc = await call()
      if (first) {
        first = false
        readTaken()
        await written
        ;(globalThis as { lateReadDone?: boolean }).lateReadDone = true
      }
      return doc
    }
  })
  await placeCaret(activePane(page).locator(editor).getByText('Start.'))
  await caretToLineEnd(page)
  await page.keyboard.type(' Fresh words.')
  await newTab(nb.app, page)
  // Checked only once the late read has answered, since that answer is what could undo the save.
  await expect
    .poll(() => nb.app.evaluate(() => (globalThis as { lateReadDone?: boolean }).lateReadDone), {
      message: "the new tab's read answered after the save"
    })
    .toBe(true)
  await expect(activePane(page).locator(editor)).toHaveText('Start. Fresh words.')
  await placeCaret(activePane(page).locator(editor).getByText('Start. Fresh words.'))
  await caretToLineEnd(page)
  await page.keyboard.type(' More.')
  await waitForFile(join(nb.workspace, 'Shared.md'), 'Start. Fresh words. More.')
})

test('a width change that cannot be saved is undone in every tab of the page', async ({
  nbWith
}) => {
  const nb = await pages(nbWith, { Wide: 'Text.\n' })
  const { page } = nb
  await open(page, 'Wide')
  await newTab(nb.app, page)
  try {
    await chmod(nb.workspace, 0o555)
    await activePane(page).getByRole('button', { name: 'Page menu' }).click()
    await page.getByRole('menuitem', { name: 'Full width' }).click()
    await expect(page.getByRole('alert')).toContainText("Couldn't update the page")
    await expect(activePane(page).locator('.page-column.full-width')).toHaveCount(0)
    await page.locator('.tab').first().click()
    await expect(activePane(page).locator('.page-column.full-width')).toHaveCount(0)
  } finally {
    await chmod(nb.workspace, 0o755)
  }
})
