import { rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import {
  caretToLineEnd,
  editor,
  frontmatter,
  menu,
  openFile,
  placeCaret,
  waitForFile
} from './helpers'

/** Opens search afresh, so its results come from the index as it is now. */
async function search(page: Page, query: string): Promise<void> {
  const dialog = page.getByRole('dialog', { name: 'Search' })
  if (await dialog.isVisible()) await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await page.keyboard.press('Meta+k')
  await dialog.getByRole('textbox').fill(query)
}

test('search shows recent pages, ranks title matches first and keeps the keyboard inside it', async ({
  nbWith
}) => {
  const nb = await nbWith({
    files: {
      'Groceries.md': 'Apples and a website notebook.\n',
      'Website Redesign.md': 'Plan the launch.\n',
      'Reading list.md': 'Books.\n'
    }
  })
  const { page } = nb
  await page.getByTestId('sidebar-row-Reading list').click()
  await page.getByTestId('sidebar-row-Groceries').click()

  await page.keyboard.press('Meta+k')
  const dialog = page.getByRole('dialog', { name: 'Search' })
  const titles = dialog.locator('.search-item-title')
  await expect(dialog.locator('.search-section')).toHaveText('Recent')
  await expect(titles).toHaveText(['Groceries', 'Reading list'])
  // A click that lands on no result must leave the arrow keys working.
  await dialog.locator('.search-footer').click()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('page-title')).toHaveText('Reading list')

  await menu(nb.app, 'Search…')
  await expect(dialog).toBeVisible()
  const input = dialog.getByRole('textbox')
  await input.fill('website')
  // Content is indexed in the background shortly after the workspace opens.
  await expect(titles).toHaveText(['Website Redesign', 'Groceries'])
  await expect(dialog.locator('.search-item-snippet').first()).toHaveText(
    'Apples and a website notebook.'
  )
  await expect(dialog.locator('.search-hit').first()).toHaveText('Website')
  await page.keyboard.press('Tab')
  await expect(input).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(input).toBeFocused()

  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(dialog).toHaveCount(0)
  await expect(page.getByTestId('page-title')).toHaveText('Groceries')
})

test('Cmd+K on selected text adds a link instead of opening search', async ({ nbWith }) => {
  const { page } = await openFile(nbWith, 'Note', 'Link this word.\n')
  await page.locator(editor).getByText('Link this word.').dblclick()
  // BlockNote binds its link shortcut only while the formatting toolbar is shown.
  await expect(page.locator('[data-test="createLink"]')).toBeVisible()
  await page.keyboard.press('Meta+k')
  await expect(page.getByRole('dialog', { name: 'Search' })).toHaveCount(0)
  await expect(page.getByPlaceholder('Edit URL')).toBeVisible()
})

test('closing search returns the cursor to the editor', async ({ nbWith }) => {
  const nb = await openFile(nbWith, 'Note', 'Some text.\n')
  const { page } = nb
  await placeCaret(page.locator(editor).getByText('Some text.'))
  await caretToLineEnd(page)
  await page.keyboard.press('Meta+k')
  const dialog = page.getByRole('dialog', { name: 'Search' })
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await page.keyboard.type(' more')
  await waitForFile(join(nb.workspace, 'Note.md'), 'Some text. more')
})

test('search follows a page edited, renamed and deleted outside the app', async ({ nbWith }) => {
  const nb = await openFile(nbWith, 'Recipe', 'Mix the flour.\n', {
    files: { 'Other.md': 'Elsewhere.\n' }
  })
  const { page, workspace } = nb
  const titles = page.getByRole('dialog', { name: 'Search' }).locator('.search-item-title')
  const empty = page.getByRole('dialog', { name: 'Search' }).locator('.search-empty')
  await search(page, 'flour')
  await expect(titles).toHaveText(['Recipe'])

  const file = join(workspace, 'Recipe.md')
  await writeFile(file, `${await frontmatter(file)}\nMix the sugar.\n`)
  // The open page reloads after the index has the new text.
  await expect(page.locator(editor)).toHaveText('Mix the sugar.')
  await search(page, 'sugar')
  await expect(titles).toHaveText(['Recipe'])
  await search(page, 'flour')
  await expect(empty).toHaveText('No results')

  await rename(file, join(workspace, 'Dessert.md'))
  await expect(page.getByTestId('sidebar-row-Dessert')).toBeVisible()
  await search(page, 'dessert')
  await expect(titles).toHaveText(['Dessert'])
  await search(page, 'recipe')
  await expect(empty).toHaveText('No results')

  await unlink(join(workspace, 'Dessert.md'))
  await expect(page.getByTestId('sidebar-row-Dessert')).toHaveCount(0)
  await search(page, 'sugar')
  await expect(empty).toHaveText('No results')
})
