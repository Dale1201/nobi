import { readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from './fixtures'
import { launchElectron } from './launch'

import {
  caretToLineEnd,
  editor,
  newPage,
  placeCaret,
  typeNewPageTitle,
  waitForFile
} from './helpers'

test('first run asks for a folder and creates the first page', async ({ tmp }) => {
  const userData = await tmp('user')
  const folder = await tmp('workspace')
  const app = await launchElectron({
    args: ['out/main/index.js'],
    env: { NOBSIDIAN_USER_DATA: userData }
  })
  const page = await app.firstWindow()
  await expect(page.getByText('Welcome to Nobsidian')).toBeVisible()
  await app.evaluate(({ dialog }, dir) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [dir]
    })) as typeof dialog.showOpenDialog
  }, folder)
  await page.getByRole('button', { name: 'Choose a folder' }).click()
  await expect(page.getByTestId('sidebar-row-Untitled')).toBeVisible()
  expect(await readdir(folder)).toContain('Untitled.md')
  await app.close()
})

test('a missing notes folder is reported, not recreated', async ({ tmp }) => {
  const userData = await tmp('user')
  const gone = join(userData, 'Moved Notes')
  await writeFile(join(userData, 'settings.json'), JSON.stringify({ lastWorkspace: gone }))
  const app = await launchElectron({
    args: ['out/main/index.js'],
    env: { NOBSIDIAN_USER_DATA: userData }
  })
  const page = await app.firstWindow()
  await expect(page.getByText("Can't find your notes")).toBeVisible()
  await expect(page.getByText(gone)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Locate folder' })).toBeVisible()
  await expect(readdir(gone)).rejects.toThrow()
  await app.close()
})

test('a folder that cannot be opened keeps the current notes', async ({ nb }) => {
  const { page, app } = nb
  await newPage(page, 'Still here')
  const notAFolder = join(nb.userData, 'not-a-folder.txt')
  await writeFile(notAFolder, 'plain file')
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [file]
    })) as typeof dialog.showOpenDialog
  }, notAFolder)
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
  nb
}) => {
  await writeFile(
    join(nb.workspace, 'Boxes.md'),
    '> [!callout] 💡\n> With icon\n>\n> - outer\n>   - inner\n\n> [!callout]\n> No icon\n>\n> Child\n'
  )
  const page = await nb.relaunch()
  await page.getByTestId('sidebar-row-Boxes').click()
  await expect(page.locator(editor)).toContainText('Child')
  const indent = (text: string): Promise<number> =>
    page
      .locator(editor)
      .getByText(text, { exact: true })
      .evaluate((el) => parseFloat(getComputedStyle(el.closest('.bn-block-group')!).marginLeft))
  expect(await indent('outer')).toBe(30)
  expect(await indent('inner')).toBeGreaterThan(0)
  expect(await indent('Child')).toBe(0)
})

test('slash menu inserts a callout and a sub-page', async ({ nb }) => {
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
  await waitForFile(join(workspace, 'Parent.md'), '(Parent/Untitled.md "page")')
  await expect(page.locator('.nb-page-link')).toHaveText(/Untitled/)
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

test('favorites, delete and dark mode', async ({ nb }) => {
  const { page, workspace } = nb
  await page.getByRole('button', { name: 'New page' }).first().click()
  await typeNewPageTitle(page, 'Keep')
  await page.getByRole('button', { name: 'Add to Favorites' }).click()
  await expect(page.locator('.sidebar-section-title', { hasText: 'Favorites' })).toBeVisible()
  await page.getByRole('button', { name: 'New page' }).first().click()
  await typeNewPageTitle(page, 'Remove me')
  await expect(page.getByTestId('sidebar-row-Remove me')).toBeVisible()
  await page.getByRole('button', { name: 'Page menu' }).click()
  await page.getByRole('menuitem', { name: 'Move to Trash' }).click()
  await expect(page.getByTestId('sidebar-row-Remove me')).toHaveCount(0)
  expect(await readdir(join(workspace, '.nobsidian', 'trash'))).toHaveLength(1)

  await nb.app.evaluate(({ Menu }) => {
    Menu.getApplicationMenu()?.getMenuItemById?.('x')
    const item = Menu.getApplicationMenu()
      ?.items.flatMap((i) => i.submenu?.items ?? [])
      .find((i) => i.label === 'Toggle Dark Mode')
    item?.click()
  })
  await expect(page.locator('html')).toHaveAttribute('data-theme', /dark|light/)
  const before = await page.locator('html').getAttribute('data-theme')
  await nb.app.evaluate(({ Menu }) => {
    Menu.getApplicationMenu()
      ?.items.flatMap((i) => i.submenu?.items ?? [])
      .find((i) => i.label === 'Toggle Dark Mode')
      ?.click()
  })
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', before ?? '')
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
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths: [file]
    })) as typeof dialog.showOpenDialog
  }, image)
  await page.getByTestId('page-title').hover()
  await page.getByRole('button', { name: 'Add cover' }).click()
  await expect(page.getByTestId('page-cover').locator('img')).toHaveJSProperty('naturalWidth', 1)
  await waitForFile(join(workspace, 'Trip.md'), /cover: attachments\/cover-\d+\.png/)

  await page.getByTestId('page-cover').hover()
  await page.getByRole('button', { name: 'Reposition' }).click({ timeout: 2000 })
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
  const { page } = nb
  await page.getByRole('button', { name: 'New page' }).first().click()
  await typeNewPageTitle(page, 'Hel')
  await page.waitForTimeout(450)
  await page.keyboard.type('lo')
  await page.locator(editor).click()
  await expect(page.getByTestId('sidebar-row-Hello')).toBeVisible()
  await page.waitForTimeout(800)
  await expect(page.getByTestId('page-title')).toHaveText('Hello')
})

test('a link whose text is code opens in the editor', async ({ nb }) => {
  const id = '22222222-2222-4222-8222-222222222222'
  await writeFile(
    join(nb.workspace, 'Commands.md'),
    `---\nid: ${id}\n---\n\nSee [\`main.rs\`](https://main.rs) here\n`
  )
  const page = await nb.relaunch()
  await page.getByTestId('sidebar-row-Commands').click()
  await expect(page.locator(editor)).toContainText('See main.rs here')
  await expect(page.locator(`${editor} a[href="https://main.rs"]`)).toHaveText('main.rs')
})
