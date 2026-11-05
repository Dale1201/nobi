import { join } from 'node:path'
import { expect, test } from './fixtures'
import { editor, openBlockMenu, openFile, waitForFile } from './helpers'

test('the handle selects the block and opens the menu with search focused', async ({ nbWith }) => {
  const { page } = await openFile(nbWith, 'Menu', 'First\n\nSecond\n')
  await openBlockMenu(page, 'Second')
  await expect(page.getByPlaceholder('Search actions…')).toBeFocused()
  await expect(page.getByRole('menu').locator('.menu-section').first()).toHaveText('Text')
  const selected = page.locator(`${editor} .nb-block-selected`)
  await expect(selected).toHaveCount(1)
  await expect(selected).toContainText('Second')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toBeHidden()
  await expect(selected).toHaveCount(0)
})

test('Turn into from the submenu, and Turn into options and colours from search', async ({
  nbWith
}) => {
  const nb = await openFile(nbWith, 'Turn', 'Make me a heading\n\nQuote me\n\nColor me\n')
  const { page } = nb
  const file = join(nb.workspace, 'Turn.md')
  await openBlockMenu(page, 'Make me')
  await page.getByRole('menuitem', { name: 'Turn into' }).hover()
  await page.getByRole('menuitem', { name: 'Heading 1', exact: true }).click()
  await waitForFile(file, '# Make me a heading')

  await openBlockMenu(page, 'Quote me')
  await page.keyboard.type('quote')
  await page.keyboard.press('Enter')
  await openBlockMenu(page, 'Color me')
  await page.keyboard.type('red back')
  await expect(page.getByRole('menu').locator('.menu-item.active')).toHaveText('Red background')
  await page.keyboard.press('Enter')
  await waitForFile(file, '> Quote me')
  await waitForFile(file, 'Color me<!-- bg=red -->')
})

test('Turn into keeps children and colours', async ({ nbWith }) => {
  const { page } = await openFile(
    nbWith,
    'Keep',
    'Parent<!-- color=red -->\n\n<div data-children>\n\nChild\n\n</div>\n'
  )
  await openBlockMenu(page, 'Parent')
  await page.keyboard.type('bulleted')
  await page.keyboard.press('Enter')
  const block = page.locator(`${editor} .bn-block-content[data-content-type="bulletListItem"]`)
  await expect(block).toHaveAttribute('data-text-color', 'red')
  await expect(page.locator(`${editor} .bn-block-group .bn-block-group`)).toContainText('Child')
})

test('Duplicate and Delete, from the menu and by shortcut, Del only with an empty search', async ({
  nbWith
}) => {
  const { page } = await openFile(nbWith, 'Dup', 'Only once\n\nKeep\n')
  const block = page.locator(`${editor} .bn-block-content`, { hasText: 'Only once' })
  await openBlockMenu(page, 'Only once')
  await page.getByRole('menuitem', { name: 'Duplicate' }).click()
  await expect(block).toHaveCount(2)
  await openBlockMenu(page, 'Only once')
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  await expect(block).toHaveCount(1)

  await openBlockMenu(page, 'Only once')
  await page.keyboard.press('Meta+d')
  await expect(block).toHaveCount(2)
  await openBlockMenu(page, 'Only once')
  await page.keyboard.type('du')
  await page.keyboard.press('Backspace')
  await expect(page.getByPlaceholder('Search actions…')).toHaveValue('d')
  await expect(page.getByRole('menu')).toBeVisible()
  await page.keyboard.press('Backspace')
  await expect(page.getByPlaceholder('Search actions…')).toHaveValue('')
  await page.keyboard.press('Backspace')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(block).toHaveCount(1)
  await expect(page.locator(editor)).toContainText('Keep')
})

test('+ adds a block below and opens the slash menu; Option-click adds above', async ({
  nbWith
}) => {
  const { page } = await openFile(nbWith, 'Plus', 'Anchor\n')
  const anchor = page.locator(`${editor} .bn-block-content`, { hasText: 'Anchor' })
  await anchor.hover()
  await page.getByRole('button', { name: 'Add a block below' }).click()
  await expect(page.locator('.slash-menu')).toBeVisible()
  await page.keyboard.press('Escape')
  await page.keyboard.type('below')
  await anchor.hover()
  await page.getByRole('button', { name: 'Add a block below' }).click({ modifiers: ['Alt'] })
  await page.keyboard.press('Escape')
  await page.keyboard.type('above')
  await expect(page.locator(`${editor} .bn-block-content`)).toHaveText([/above/, /Anchor/, /below/])
})
