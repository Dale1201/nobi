import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { GOOD_KEY } from './fakeAnthropic'
import { expect, test, type AppFixture } from './fixtures'
import { editor, waitForFile } from './helpers'

/** Opens Aztec, which shows its sub-page Plan as a page block. */
async function withSubPage(nb: AppFixture, body = 'First idea\n'): Promise<Page> {
  await writeFile(join(nb.workspace, 'Aztec.md'), `${body}\n[Plan](Aztec/Plan.md "page")\n`)
  await mkdir(join(nb.workspace, 'Aztec'))
  await writeFile(join(nb.workspace, 'Aztec', 'Plan.md'), 'Plan body\n')
  const page = await nb.relaunch()
  const row = page.getByTestId('sidebar-row-Aztec')
  await row.click()
  await row.hover()
  await row.getByRole('button', { name: 'Expand' }).click()
  await expect(page.getByTestId('sidebar-row-Plan')).toBeVisible()
  await expect(page.locator(`${editor} .nb-page-link`)).toHaveText('Plan')
  return page
}

async function openBlockMenu(page: Page, target: string): Promise<void> {
  await page.locator(target).first().hover()
  await page.getByRole('button', { name: 'Block menu' }).click()
  await expect(page.getByRole('menu')).toBeVisible()
}

const pageBlock = `${editor} .nb-page-link`
const title = (page: Page): Locator => page.locator('.tab-pane.active').getByTestId('page-title')
const labels = (page: Page): Promise<string[]> =>
  page.getByRole('menu').locator('.menu-item .menu-item-label').allTextContents()

test('a sub-page block menu has page actions with their shortcuts', async ({ nb }) => {
  const page = await withSubPage(nb)
  await openBlockMenu(page, pageBlock)
  const menu = page.getByRole('menu')
  await expect(menu.locator('.menu-section').first()).toHaveText('Page')
  expect(await labels(page)).toEqual([
    'Edit icon',
    'Add to Favorites',
    'Rename',
    'Open in new tab',
    'Reveal in Finder',
    'Copy file path',
    'Duplicate',
    'Move to',
    'Move to Trash',
    'Ask AI'
  ])
  const hint = (name: string): Locator =>
    menu.getByRole('menuitem', { name }).locator('.menu-item-hint')
  await expect(hint('Rename')).toHaveText('⌘⇧R')
  await expect(hint('Open in new tab')).toHaveText('⌘⇧↵')
  await expect(hint('Duplicate')).toHaveText('⌘D')
  await expect(hint('Move to')).toHaveText('⌘⇧P')
  await expect(hint('Ask AI')).toHaveText('⌘J')
})

test('Move to Trash on a page block removes the block, and a restore puts it back', async ({
  nb
}) => {
  const page = await withSubPage(nb)
  await openBlockMenu(page, pageBlock)
  await page.getByRole('menuitem', { name: 'Move to Trash' }).click()
  await expect(page.getByTestId('sidebar-row-Plan')).toHaveCount(0)
  await expect(page.locator(pageBlock)).toHaveCount(0)
  await expect(title(page)).toHaveText('Aztec')
  await waitForFile(join(nb.workspace, 'Aztec.md'), /---\n\nFirst idea\n$/)
  await expect(page.getByText('This page was changed outside Nobsidian.')).toHaveCount(0)

  await page.getByRole('button', { name: 'Trash', exact: true }).click()
  await page.getByTestId('trash-item-Plan').click()
  await page.getByRole('button', { name: 'Restore page' }).click()
  await waitForFile(join(nb.workspace, 'Aztec.md'), 'First idea\n\n[Plan](Aztec/Plan.md "page")\n')
})

test('Rename on a page block renames the page in place', async ({ nb }) => {
  const page = await withSubPage(nb)
  await openBlockMenu(page, pageBlock)
  await page.getByRole('menuitem', { name: 'Rename' }).click()
  const input = page.getByRole('textbox', { name: 'Page title' })
  await expect(input).toBeFocused()
  await expect(input).toHaveValue('Plan')
  await page.keyboard.press('Meta+a')
  await page.keyboard.type('Roadmap')
  await page.keyboard.press('Enter')
  await expect(input).toHaveCount(0)
  await expect(page.locator(pageBlock)).toHaveText('Roadmap')
  await expect(page.getByTestId('sidebar-row-Roadmap')).toBeVisible()
  await expect(title(page)).toHaveText('Aztec')

  await openBlockMenu(page, pageBlock)
  await page.keyboard.press('Meta+Shift+r')
  await page.keyboard.type('Ignored')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveCount(0)
  await expect(page.locator(pageBlock)).toHaveText('Roadmap')
})

test('Edit icon on a page block sets the sub-page icon', async ({ nb }) => {
  const page = await withSubPage(nb)
  await openBlockMenu(page, pageBlock)
  await page.getByRole('menuitem', { name: 'Edit icon' }).click()
  await page.getByPlaceholder('Filter…').fill('airplane')
  await page.locator('.nb-icon-picker-emoji', { hasText: '✈️' }).click()
  await expect(page.locator('.icon-picker')).toHaveCount(0)
  await expect(page.locator(`${pageBlock} .nb-page-link-icon`)).toHaveText('✈️')
  await expect(page.getByTestId('sidebar-row-Plan').locator('.page-icon')).toHaveText('✈️')
  await waitForFile(join(nb.workspace, 'Aztec', 'Plan.md'), 'icon: ✈️')
})

test('⌘D in a page block menu duplicates the page and stays on the parent', async ({ nb }) => {
  const page = await withSubPage(nb)
  await openBlockMenu(page, pageBlock)
  await page.keyboard.press('Meta+d')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(page.locator(pageBlock)).toHaveText(['Plan', 'Plan (1)'])
  await expect(title(page)).toHaveText('Aztec')
  await expect(page.getByTestId('sidebar-row-Plan (1)')).toBeVisible()
})

test('⌘⇧P in a page block menu opens Move to for that page', async ({ nb }) => {
  const page = await withSubPage(nb)
  await openBlockMenu(page, pageBlock)
  await page.keyboard.press('Meta+Shift+p')
  await expect(page.getByPlaceholder('Move page to…')).toBeVisible()
})

test('a link to a page elsewhere keeps the block menu, with Open in new tab', async ({ nb }) => {
  await writeFile(join(nb.workspace, 'Other.md'), 'Elsewhere\n')
  await writeFile(join(nb.workspace, 'Links.md'), 'Intro\n\n[Other](Other.md "page")\n')
  const page = await nb.relaunch()
  await page.getByTestId('sidebar-row-Links').click()
  await openBlockMenu(page, pageBlock)
  expect(await labels(page)).toEqual(['Open in new tab', 'Duplicate', 'Delete', 'Ask AI'])
  await page.keyboard.press('Meta+Shift+Enter')
  await expect(page.locator('.tab')).toHaveCount(2)
  await expect(title(page)).toHaveText('Other')
})

test('block menu shortcuts: ⌘D duplicates, Del deletes only with an empty search', async ({
  nb
}) => {
  await writeFile(join(nb.workspace, 'Keys.md'), 'Only once\n\nKeep\n')
  const page = await nb.relaunch()
  await page.getByTestId('sidebar-row-Keys').click()
  const block = `${editor} .bn-block-content:has-text("Only once")`
  await openBlockMenu(page, block)
  await page.keyboard.press('Meta+d')
  await expect(page.locator(block)).toHaveCount(2)

  await openBlockMenu(page, block)
  await page.keyboard.type('du')
  await page.keyboard.press('Backspace')
  await expect(page.getByPlaceholder('Search actions…')).toHaveValue('d')
  await expect(page.getByRole('menu')).toBeVisible()
  await page.keyboard.press('Backspace')
  await expect(page.getByPlaceholder('Search actions…')).toHaveValue('')
  await page.keyboard.press('Backspace')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(page.locator(block)).toHaveCount(1)
  await expect(page.locator(editor)).toContainText('Keep')
})

test('Ask AI in the block menu opens the Writer on that block', async ({ nb }) => {
  await nb.page.evaluate((key) => window.api.invoke('ai:setKey', { key }), GOOD_KEY)
  await writeFile(join(nb.workspace, 'Ai.md'), 'Intro.\n\nRewrite me.\n')
  const page = await nb.relaunch()
  await page.getByTestId('sidebar-row-Ai').click()
  await openBlockMenu(page, `${editor} .bn-block-content:has-text("Rewrite me.")`)
  await page.getByRole('menuitem', { name: 'Ask AI' }).click()
  const writer = page.getByRole('dialog', { name: 'AI' })
  await expect(writer.getByRole('textbox', { name: 'Ask AI' })).toBeFocused()
  const selected = page.locator(`${editor} .nb-block-selected`)
  await expect(selected).toHaveCount(1)
  await expect(selected).toContainText('Rewrite me.')
})

test('sidebar page menu: header, Move to Trash, and shortcuts', async ({ nb }) => {
  await writeFile(join(nb.workspace, 'Alpha.md'), 'a\n')
  await writeFile(join(nb.workspace, 'Beta.md'), 'b\n')
  const page = await nb.relaunch()
  await page.getByTestId('sidebar-row-Beta').click()
  const openRowMenu = async (title: string): Promise<void> => {
    const row = page.getByTestId(`sidebar-row-${title}`)
    await row.hover()
    await row.getByRole('button', { name: 'Page actions' }).click()
  }
  await openRowMenu('Alpha')
  const menu = page.getByRole('menu')
  await expect(menu.locator('.menu-section').first()).toHaveText('Page')
  expect(await labels(page)).toEqual([
    'Add to Favorites',
    'Duplicate',
    'Rename',
    'Move to',
    'Move to Trash',
    'Open in new tab',
    'Reveal in Finder',
    'Copy file path'
  ])
  await page.keyboard.press('Meta+Shift+r')
  await expect(page.getByTestId('sidebar-row-Alpha').locator('.rename-input')).toBeFocused()
  await page.keyboard.press('Escape')

  await openRowMenu('Alpha')
  await page.keyboard.press('Meta+Shift+Enter')
  await expect(page.locator('.tab')).toHaveCount(2)
  await expect(title(page)).toHaveText('Alpha')

  await openRowMenu('Alpha')
  await page.keyboard.press('Meta+Shift+p')
  await expect(page.getByPlaceholder('Move page to…')).toBeVisible()
})

test('top bar page menu: search, Move to, Move to Trash, and a Full width check', async ({
  nb
}) => {
  await writeFile(join(nb.workspace, 'Top.md'), 't\n')
  const page = await nb.relaunch()
  await page.getByTestId('sidebar-row-Top').click()
  await page.getByRole('button', { name: 'Page menu' }).click()
  await expect(page.getByPlaceholder('Search actions…')).toBeFocused()
  expect(await labels(page)).toEqual([
    'Duplicate',
    'Move to',
    'Move to Trash',
    'Reveal in Finder',
    'Copy file path',
    'Full width',
    'Page history'
  ])
  await page.getByRole('menuitem', { name: 'Full width' }).click()
  await expect(page.locator('.page-column.full-width').first()).toBeVisible()
  await page.getByRole('button', { name: 'Page menu' }).click()
  await expect(
    page.getByRole('menuitem', { name: 'Full width' }).locator('.menu-item-check')
  ).toBeVisible()
  await page.keyboard.type('delete')
  expect(await labels(page)).toEqual(['Move to Trash'])
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('sidebar-row-Top')).toHaveCount(0)
})

test(
  'Copy file path and Reveal in Finder act on the page file',
  { tag: '@clipboard' },
  async ({ nb }) => {
    const page = await withSubPage(nb)
    const file = join(nb.workspace, 'Aztec', 'Plan.md')
    await nb.app.evaluate(({ shell }) => {
      const g = globalThis as { revealed?: string }
      shell.showItemInFolder = (path) => void (g.revealed = path)
    })
    const row = page.getByTestId('sidebar-row-Plan')
    await row.hover()
    await row.getByRole('button', { name: 'Page actions' }).click()
    await page.getByRole('menuitem', { name: 'Copy file path' }).click()
    await expect.poll(() => nb.app.evaluate(({ clipboard }) => clipboard.readText())).toBe(file)

    await openBlockMenu(page, pageBlock)
    await page.getByRole('menuitem', { name: 'Reveal in Finder' }).click()
    await expect
      .poll(() => nb.app.evaluate(() => (globalThis as { revealed?: string }).revealed))
      .toBe(file)
  }
)
