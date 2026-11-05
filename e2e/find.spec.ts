import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { expect, test } from './fixtures'
import {
  activePane,
  editor,
  frontmatter,
  menu,
  newTab,
  openFile,
  placeCaret,
  waitForFile
} from './helpers'

const bar = (page: Page): Locator => activePane(page).getByTestId('find-bar')
const count = (page: Page): Locator => bar(page).getByTestId('find-count')

/** A menu click reaches the window later, so typing waits for the find field to take focus. */
async function openFind(app: ElectronApplication, page: Page, label = 'Find…'): Promise<void> {
  await menu(app, label)
  await expect(bar(page).getByTestId('find-input')).toBeFocused()
}

test('Cmd+F finds, steps through matches, leaves the match selected and reopens with it', async ({
  nbWith
}) => {
  const { page, app } = await openFile(
    nbWith,
    'Fruit',
    'Apple pie\n\nan apple a day\n\nNo fruit here\n\nAPPLE\n\npie\n'
  )
  await openFind(app, page)
  await page.keyboard.type('apple')
  await expect(count(page)).toHaveText('1/3')
  await expect(page.locator(`${editor} .nb-find-match`)).toHaveCount(3)
  await expect(page.locator(`${editor} .nb-find-current`)).toHaveText('Apple')
  await page.keyboard.press('Enter')
  await expect(count(page)).toHaveText('2/3')
  await expect(page.locator(`${editor} .nb-find-current`)).toHaveText('apple')
  await page.keyboard.press('Shift+Enter')
  await expect(count(page)).toHaveText('1/3')
  await menu(app, 'Find Next')
  await expect(count(page)).toHaveText('2/3')
  await page.keyboard.press('Backspace')
  await page.keyboard.type('xyz')
  await expect(count(page)).toHaveText('No results')
  await page.keyboard.press('Meta+a')
  await page.keyboard.type('day')
  await page.keyboard.press('Escape')
  await expect(bar(page)).toHaveCount(0)
  await expect(page.locator(`${editor} .nb-find-match`)).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe('day')
  await placeCaret(page.locator(editor).getByText('pie', { exact: true }), 2)
  await menu(app, 'Find…')
  await expect(bar(page).getByTestId('find-input'), 'the bar opens with the selection').toHaveValue(
    'pie'
  )
  await expect(count(page), 'the selected match is the current one').toHaveText('2/2')
})

test('replace changes one match, replace all the rest, and one undo restores them', async ({
  nbWith
}) => {
  const { page, app, workspace } = await openFile(nbWith, 'Colors', 'red, **red** and red\n')
  await openFind(app, page, 'Find and Replace…')
  await page.keyboard.type('red')
  await expect(count(page)).toHaveText('1/3')
  await bar(page).getByTestId('replace-input').fill('blue')
  await bar(page).getByRole('button', { name: 'Replace', exact: true }).click()
  await expect(page.locator(editor)).toContainText('blue, red and red')
  await expect(count(page)).toHaveText('1/2')
  await bar(page).getByRole('button', { name: 'Replace all' }).click()
  await expect(page.locator(editor)).toContainText('blue, blue and blue')
  await expect(count(page)).toHaveText('No results')
  await waitForFile(join(workspace, 'Colors.md'), 'blue, **blue** and blue')
  await page.keyboard.press('Escape')
  await expect(page.locator(editor)).toBeFocused()
  await page.keyboard.press('Meta+z')
  await expect(page.locator(editor)).toContainText('blue, red and red')
})

test('a match inside a closed toggle opens it', async ({ nbWith }) => {
  const { page, app } = await openFile(
    nbWith,
    'Toggles',
    '<details>\n<summary>Open me</summary>\n\nHidden needle\n\n</details>\n'
  )
  const hidden = page.locator(editor).getByText('Hidden needle')
  await expect(hidden).toBeHidden()
  await openFind(app, page)
  await page.keyboard.type('needle')
  await expect(count(page)).toHaveText('1/1')
  await expect(hidden).toBeVisible()
  await expect(page.locator(`${editor} .bn-toggle-button`)).toHaveAttribute('aria-expanded', 'true')
})

test('each tab keeps its own find bar', async ({ nbWith }) => {
  const { page, app } = await openFile(nbWith, 'First', 'alpha beta\n')
  await openFind(app, page)
  await page.keyboard.type('beta')
  await expect(count(page)).toHaveText('1/1')
  await newTab(app, page)
  await expect(bar(page)).toHaveCount(0)
  await page.getByTestId('sidebar-row-First').click()
  await expect(activePane(page).getByTestId('page-title')).toHaveText('First')
  await expect(bar(page)).toHaveCount(0)
  await page.locator('.tab').first().click()
  await expect(count(page)).toHaveText('1/1')
})

test('the bar keeps searching a page another app edits', async ({ nbWith }) => {
  const { page, app, workspace } = await openFile(nbWith, 'Shared', 'one apple\n')
  const file = join(workspace, 'Shared.md')
  const head = await frontmatter(file)
  await openFind(app, page)
  await page.keyboard.type('apple')
  await expect(count(page)).toHaveText('1/1')
  await writeFile(file, `${head}\napple pie\n\nand an apple\n`)
  await expect(page.locator(editor)).toContainText('and an apple')
  await expect(count(page)).toHaveText('1/2')
  await expect(page.locator(`${editor} .nb-find-match`)).toHaveCount(2)
  await bar(page).getByRole('button', { name: 'Show replace' }).click()
  await bar(page).getByTestId('replace-input').fill('pear')
  await bar(page).getByRole('button', { name: 'Replace all' }).click()
  await expect(page.locator(editor)).toContainText('pear pie')
  await waitForFile(file, 'and an pear')
})
