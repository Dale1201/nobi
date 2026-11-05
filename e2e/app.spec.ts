import { readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, launch, test } from './fixtures'
import {
  caretToLineEnd,
  editor,
  traceIpc,
  newPage,
  openFile,
  placeCaret,
  stubOpenDialog,
  typeNewPageTitle,
  waitForFile
} from './helpers'

test('first run opens a sandboxed window that asks for a folder and creates the first page', async ({
  tmp
}) => {
  const userData = await tmp('user')
  const folder = await tmp('workspace')
  const { app, page } = await launch(userData)
  await expect(page).toHaveTitle('Nobsidian')
  expect(await app.evaluate(({ app }) => app.getPath('userData'))).toBe(userData)
  if (process.env.NOBSIDIAN_E2E_SHOW !== '1') {
    expect(
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())
    ).toBe(false)
  }
  expect(await page.evaluate(() => typeof (globalThis as { require?: unknown }).require)).toBe(
    'undefined'
  )
  await expect(page.getByText('Welcome to Nobsidian')).toBeVisible()
  await stubOpenDialog(app, [folder])
  await page.getByRole('button', { name: 'Choose a folder' }).click()
  await expect(page.getByTestId('sidebar-row-Untitled')).toBeVisible()
  await expect.poll(() => readdir(folder)).toContain('Untitled.md')
})

test('a missing notes folder is reported, not recreated', async ({ tmp }) => {
  const userData = await tmp('user')
  const gone = join(userData, 'Moved Notes')
  await writeFile(join(userData, 'settings.json'), JSON.stringify({ lastWorkspace: gone }))
  const { page } = await launch(userData)
  await expect(page.getByText("Can't find your notes")).toBeVisible()
  await expect(page.getByText(gone)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Locate folder' })).toBeVisible()
  // Startup has finished with no folder open, so nothing is left that would create it.
  expect(await page.evaluate(() => window.api.invoke('workspace:current', undefined))).toBeNull()
  await expect(readdir(gone)).rejects.toThrow()
})

test('a folder that cannot be opened keeps the current notes', async ({ nb }) => {
  const { page, app } = nb
  await newPage(page, 'Still here')
  const notAFolder = join(nb.userData, 'not-a-folder.txt')
  await writeFile(notAFolder, 'plain file')
  await stubOpenDialog(app, [notAFolder])
  await page.locator('.sidebar-workspace').click()
  await page.getByText('Open another folder…').click()
  await expect(page.getByRole('alert')).toContainText("Couldn't open that folder")
  await page.getByRole('button', { name: 'New page' }).first().click()
  await expect(page.getByTestId('page-title')).toBeFocused()
  await expect(page.getByTestId('sidebar-row-Still here')).toBeVisible()
})

test('remembers the window size', async ({ nb }) => {
  // macOS clamps windows to the screen, so pick a size that fits whatever display runs the test.
  const set = await nb.app.evaluate(({ BrowserWindow, screen }) => {
    const area = screen.getPrimaryDisplay().workArea
    const win = BrowserWindow.getAllWindows()[0]
    win.setBounds({
      x: area.x + 20,
      y: area.y + 20,
      width: Math.min(1000, area.width - 40),
      height: Math.min(640, area.height - 40)
    })
    return win.getBounds()
  })
  await nb.relaunch()
  const bounds = await nb.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getBounds()
  )
  expect(bounds).toMatchObject({ width: set.width, height: set.height })
})

test('writing a page saves Markdown to disk', async ({ nb }) => {
  const { page, workspace } = nb
  await page.getByRole('button', { name: 'New page' }).first().click()
  await typeNewPageTitle(page, 'Meeting notes')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('sidebar-row-Meeting notes')).toBeVisible()
  await page.keyboard.type('# Agenda')
  await page.keyboard.press('Enter')
  await page.keyboard.type('- first item')
  await page.keyboard.press('Enter')
  await page.keyboard.type('second item')
  const text = await waitForFile(join(workspace, 'Meeting notes.md'), 'second item')
  expect(text).toMatch(/# Agenda\n\n- first item\n- second item\n/)
})

test('clicking a callout icon changes or removes it', async ({ nb }) => {
  const { page, workspace } = nb
  await page.getByRole('button', { name: 'New page' }).first().click()
  await typeNewPageTitle(page, 'Notes')
  await page.keyboard.press('Enter')
  await page.keyboard.type('/callout')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Heads up')
  await waitForFile(join(workspace, 'Notes.md'), '> [!callout] 💡\n> Heads up')
  await page.locator('.nb-callout-icon').click()
  await page.getByPlaceholder('Filter…').fill('airplane')
  await page.locator('.nb-icon-picker-emoji', { hasText: '✈️' }).click()
  await expect(page.locator('.icon-picker')).toHaveCount(0)
  await expect(page.locator('.nb-callout-icon')).toHaveText('✈️')
  await waitForFile(join(workspace, 'Notes.md'), '> [!callout] ✈️\n> Heads up')

  await page.locator('.nb-callout-icon').click()
  await page.getByRole('button', { name: 'Remove' }).click()
  await expect(page.locator('.nb-callout-icon')).toHaveCount(0)
  await waitForFile(join(workspace, 'Notes.md'), '> [!callout]\n> Heads up')
})

test('callout children line up with the text, or the edge when there is no icon', async ({
  nbWith
}) => {
  const { page } = await openFile(
    nbWith,
    'Boxes',
    '> [!callout] 💡\n> With icon\n>\n> - outer\n>   - inner\n\n> [!callout]\n> No icon\n>\n> Child\n'
  )
  await expect(page.locator(editor)).toContainText('Child')
  const indent = (text: string): Promise<number> =>
    page
      .locator(editor)
      .getByText(text, { exact: true })
      .evaluate((el) => parseFloat(getComputedStyle(el.closest('.bn-block-group')!).marginLeft))
  await expect.poll(() => indent('outer')).toBe(30)
  await expect.poll(() => indent('inner')).toBeGreaterThan(0)
  await expect.poll(() => indent('Child')).toBe(0)
})

test('slash menu inserts a callout and a sub-page linked once', async ({ nb }) => {
  const { page, workspace } = nb
  await page.getByRole('button', { name: 'New page' }).first().click()
  await typeNewPageTitle(page, 'Parent')
  await page.keyboard.press('Enter')
  await page.keyboard.type('/callout')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Remember this')
  await waitForFile(join(workspace, 'Parent.md'), '> [!callout] 💡\n> Remember this')
  await placeCaret(page.locator(editor))
  await caretToLineEnd(page)
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.type('/page')
  await page.keyboard.press('Enter')
  const text = await waitForFile(join(workspace, 'Parent.md'), '(Parent/Untitled.md "page")')
  expect(text.match(/"page"\)/g)).toHaveLength(1)
  await expect(page.locator('.nb-page-link')).toHaveText([/Untitled/])
  await page.locator('.nb-page-link').click()
  await expect(page.locator('.breadcrumbs')).toHaveText(/Parent\s*\/\s*Untitled/)
})

test('renaming a parent moves its folder and keeps links working', async ({ nb }) => {
  const { page, workspace } = nb
  await page.getByRole('button', { name: 'New page' }).first().click()
  await typeNewPageTitle(page, 'Projects')
  await page.getByTestId('sidebar-row-Projects').hover()
  await page
    .getByTestId('sidebar-row-Projects')
    .getByRole('button', { name: 'Add a page inside' })
    .click()
  await typeNewPageTitle(page, 'Website')
  await expect(page.getByTestId('sidebar-row-Website')).toBeVisible()
  await expect
    .poll(() => readdir(join(workspace, 'Projects')).catch(() => []))
    .toEqual(['Website.md'])
  await page.getByTestId('sidebar-row-Projects').click()
  await page.getByTestId('page-title').click()
  await page.keyboard.press('End')
  await page.keyboard.type(' 2026')
  await expect(page.getByTestId('sidebar-row-Projects 2026')).toBeVisible()
  await expect
    .poll(() => readdir(join(workspace, 'Projects 2026')).catch(() => []))
    .toEqual(['Website.md'])
})

test('edits survive a restart, including the last open page', async ({ nb }) => {
  let page = nb.page
  await page.getByRole('button', { name: 'New page' }).first().click()
  await typeNewPageTitle(page, 'Journal')
  await page.keyboard.press('Enter')
  await page.keyboard.type('Dear diary')
  page = await nb.relaunch()
  await expect(page.getByTestId('page-title')).toHaveText('Journal')
  await expect(page.locator(editor)).toContainText('Dear diary')
})

test('page icon from the emoji picker and an uploaded cover', async ({ nb, tmp }) => {
  const { page, workspace, app } = nb
  await page.getByRole('button', { name: 'New page' }).first().click()
  await typeNewPageTitle(page, 'Trip')
  await page.getByTestId('page-title').hover()
  await page.getByRole('button', { name: 'Add icon' }).click()
  await page.getByTestId('page-icon').click()
  await page.getByPlaceholder('Filter…').fill('airplane')
  await page.locator('.nb-icon-picker-emoji', { hasText: '✈️' }).click()
  await expect(page.getByTestId('page-icon')).toHaveText('✈️')
  await waitForFile(join(workspace, 'Trip.md'), 'icon: ✈️')

  const image = join(await tmp('outside'), `cover-${Date.now()}.png`)
  await writeFile(
    image,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    )
  )
  await stubOpenDialog(app, [image])
  await page.getByTestId('page-title').hover()
  await page.getByRole('button', { name: 'Add cover' }).click()
  await expect(page.getByTestId('page-cover').locator('img')).toHaveJSProperty('naturalWidth', 1)
  await waitForFile(join(workspace, 'Trip.md'), /cover: attachments\/cover-\d+\.png/)

  await page.getByTestId('page-cover').hover()
  await page.getByRole('button', { name: 'Reposition' }).click()
  await expect(page.getByRole('button', { name: 'Save position' })).toBeVisible()
})

test('a title typed just before quitting is kept', async ({ nb }) => {
  await nb.page.getByRole('button', { name: 'New page' }).first().click()
  await typeNewPageTitle(nb.page, 'Journal')
  const page = await nb.relaunch()
  await expect(page.getByTestId('page-title')).toHaveText('Journal')
  expect(await readdir(nb.workspace)).toContain('Journal.md')
})

test('a title still being typed is not reverted by an earlier rename', async ({ nb }) => {
  const { page, app } = nb
  // Renames are held back until released, still in order, so the echo of "Hel" lands mid-typing.
  const renames = await traceIpc(app, 'page:rename', { held: true })
  await page.getByRole('button', { name: 'New page' }).first().click()
  await typeNewPageTitle(page, 'Hel')
  await expect
    .poll(async () => (await renames.counts()).started, { message: 'rename of Hel sent' })
    .toBe(1)
  await page.keyboard.type('lo')
  await renames.release()
  await expect
    .poll(async () => (await renames.counts()).finished, { message: 'rename of Hel done' })
    .toBeGreaterThanOrEqual(1)
  // The echo is sent before the rename answers, so this round trip comes back after it.
  await page.evaluate(() => window.api.invoke('tree:get', undefined))
  await expect(page.getByTestId('page-title')).toHaveText('Hello')
  await page.locator(editor).click()
  await expect(page.getByTestId('sidebar-row-Hello')).toBeVisible()
  await expect(page.getByTestId('page-title')).toHaveText('Hello')
})

test('a link whose text is code opens in the editor', async ({ nbWith }) => {
  const { page } = await openFile(nbWith, 'Commands', 'See [`main.rs`](https://main.rs) here\n')
  await expect(page.locator(editor)).toContainText('See main.rs here')
  await expect(page.locator(`${editor} a[href="https://main.rs"]`)).toHaveText('main.rs')
})
