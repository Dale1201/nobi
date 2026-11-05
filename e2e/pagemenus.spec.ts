import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { expect, test, type AppFixture, type Seed } from './fixtures'
import { activePane, editor, openBlockMenu, openFile, waitForFile } from './helpers'

/** Opens Aztec, which shows its sub-page Plan as a page block. */
async function withSubPage(
  nbWith: (seed: Seed) => Promise<AppFixture>,
  body = 'First idea\n'
): Promise<AppFixture> {
  const nb = await nbWith({
    files: { 'Aztec.md': `${body}\n[Plan](Aztec/Plan.md "page")\n`, 'Aztec/Plan.md': 'Plan body\n' }
  })
  const { page } = nb
  const row = page.getByTestId('sidebar-row-Aztec')
  await row.click()
  await row.hover()
  await row.getByRole('button', { name: 'Expand' }).click()
  await expect(page.getByTestId('sidebar-row-Plan')).toBeVisible()
  await expect(page.locator(`${editor} .nb-page-link`)).toHaveText('Plan')
  return nb
}

const pageBlock = `${editor} .nb-page-link`
const title = (page: Page): Locator => activePane(page).getByTestId('page-title')
const labels = (page: Page): Locator =>
  page.getByRole('menu').locator('.menu-item .menu-item-label')

test('a sub-page block menu lists page actions with their shortcuts, and the shortcuts work', async ({
  nbWith
}) => {
  const { page } = await withSubPage(nbWith)
  await openBlockMenu(page, { selector: pageBlock })
  const menu = page.getByRole('menu')
  await expect(menu.locator('.menu-section').first()).toHaveText('Page')
  await expect(labels(page)).toHaveText([
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

  await page.keyboard.press('Meta+Shift+p')
  const moveTo = page.getByPlaceholder('Move page to…')
  await expect(moveTo).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(moveTo).toBeHidden()

  await openBlockMenu(page, { selector: pageBlock })
  await page.keyboard.press('Meta+d')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(page.locator(pageBlock)).toHaveText(['Plan', 'Plan (1)'])
  await expect(title(page)).toHaveText('Aztec')
  await expect(page.getByTestId('sidebar-row-Plan (1)')).toBeVisible()
})

test('Rename, Edit icon and Move to Trash on a page block act on the sub-page in place', async ({
  nbWith
}) => {
  const nb = await withSubPage(nbWith)
  const { page } = nb
  await openBlockMenu(page, { selector: pageBlock })
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

  await openBlockMenu(page, { selector: pageBlock })
  await page.keyboard.press('Meta+Shift+r')
  await page.keyboard.type('Ignored')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('textbox', { name: 'Page title' })).toHaveCount(0)
  await expect(page.locator(pageBlock)).toHaveText('Roadmap')

  await openBlockMenu(page, { selector: pageBlock })
  await page.getByRole('menuitem', { name: 'Edit icon' }).click()
  await page.getByPlaceholder('Filter…').fill('airplane')
  await page.locator('.nb-icon-picker-emoji', { hasText: '✈️' }).click()
  await expect(page.locator('.icon-picker')).toHaveCount(0)
  await expect(page.locator(`${pageBlock} .nb-page-link-icon`)).toHaveText('✈️')
  await expect(page.getByTestId('sidebar-row-Roadmap').locator('.page-icon')).toHaveText('✈️')
  await waitForFile(join(nb.workspace, 'Aztec', 'Roadmap.md'), 'icon: ✈️')

  // Restoring the link from Trash is covered in subpages.spec.
  await openBlockMenu(page, { selector: pageBlock })
  await page.getByRole('menuitem', { name: 'Move to Trash' }).click()
  await expect(page.getByTestId('sidebar-row-Roadmap')).toHaveCount(0)
  await expect(page.locator(pageBlock)).toHaveCount(0)
  await expect(title(page)).toHaveText('Aztec')
  await waitForFile(join(nb.workspace, 'Aztec.md'), /---\n\nFirst idea\n$/)
  await expect(page.getByText('This page was changed outside Nobsidian.')).toHaveCount(0)
})

test('a link to a page elsewhere keeps the block menu, with Open in new tab', async ({
  nbWith
}) => {
  const { page } = await openFile(nbWith, 'Links', 'Intro\n\n[Other](Other.md "page")\n', {
    files: { 'Other.md': 'Elsewhere\n' }
  })
  await openBlockMenu(page, { selector: pageBlock })
  await expect(labels(page)).toHaveText(['Open in new tab', 'Duplicate', 'Delete', 'Ask AI'])
  await page.keyboard.press('Meta+Shift+Enter')
  await expect(page.locator('.tab')).toHaveCount(2)
  await expect(title(page)).toHaveText('Other')
})

test('sidebar page menu: header, Move to Trash, and shortcuts', async ({ nbWith }) => {
  const { page } = await openFile(nbWith, 'Beta', 'b\n', { files: { 'Alpha.md': 'a\n' } })
  const openRowMenu = async (title: string): Promise<void> => {
    const row = page.getByTestId(`sidebar-row-${title}`)
    await row.hover()
    await row.getByRole('button', { name: 'Page actions' }).click()
  }
  await openRowMenu('Alpha')
  const menu = page.getByRole('menu')
  await expect(menu.locator('.menu-section').first()).toHaveText('Page')
  await expect(labels(page)).toHaveText([
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

test('top bar page menu: search, Duplicate, Move to Trash, and a Full width check', async ({
  nbWith
}) => {
  const nb = await openFile(nbWith, 'Top', 'Body\n')
  const { page } = nb
  await page.getByRole('button', { name: 'Page menu' }).click()
  await expect(page.getByPlaceholder('Search actions…')).toBeFocused()
  await expect(labels(page)).toHaveText([
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
  await expect(labels(page)).toHaveText(['Move to Trash'])
  await page.keyboard.press('Escape')

  await page.getByRole('button', { name: 'Page menu' }).click()
  await page.getByRole('menuitem', { name: 'Duplicate', exact: true }).click()
  await expect(title(page)).toHaveText('Top (1)')
  await expect(page.locator(editor)).toContainText('Body')
  await waitForFile(join(nb.workspace, 'Top (1).md'), 'Body')

  await page.getByRole('button', { name: 'Page menu' }).click()
  await page.keyboard.type('delete')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('sidebar-row-Top (1)')).toHaveCount(0)
  await expect(page.getByTestId('sidebar-row-Top')).toBeVisible()
})

test(
  'Copy file path and Reveal in Finder act on the page file',
  { tag: '@clipboard' },
  async ({ nbWith }) => {
    const nb = await withSubPage(nbWith)
    const { page } = nb
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

    await openBlockMenu(page, { selector: pageBlock })
    await page.getByRole('menuitem', { name: 'Reveal in Finder' }).click()
    await expect
      .poll(() => nb.app.evaluate(() => (globalThis as { revealed?: string }).revealed))
      .toBe(file)
  }
)
