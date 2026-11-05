import { access, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import {
  caretToLineEnd,
  editor,
  frontmatter,
  newPage,
  placeCaret,
  rowAction,
  waitForFile
} from './helpers'

async function openHistory(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Page menu' }).click()
  await page.getByRole('menuitem', { name: 'Page history' }).click()
}

async function restore(page: Page): Promise<void> {
  await page
    .getByRole('dialog', { name: 'Page history' })
    .getByRole('button', { name: 'Restore version' })
    .click()
  await page
    .getByRole('dialog', { name: /^Restore the version from/ })
    .getByRole('button', { name: 'Restore' })
    .click()
}

test('page history previews an older version and restores it after a rename and move', async ({
  nbWith
}) => {
  const nb = await nbWith({
    files: {
      'Essay.md': 'First draft\n\nSee [Notes](Notes.md).\n',
      'Notes.md': 'Notes.\n',
      'Drafts.md': 'Drafts.\n'
    }
  })
  const { page, workspace } = nb
  await page.getByTestId('sidebar-row-Essay').click()
  await openHistory(page)
  const dialog = page.getByRole('dialog', { name: 'Page history' })
  await expect(dialog.locator('.history-item')).toHaveCount(1)
  await dialog.getByRole('button', { name: 'Close' }).click()

  await placeCaret(page.locator(editor).getByText('First draft'))
  await caretToLineEnd(page)
  await page.keyboard.type(', then rewritten')
  await waitForFile(join(workspace, 'Essay.md'), 'then rewritten')
  await openHistory(page)
  await expect(dialog.locator('.history-item')).toHaveCount(2)
  await expect(dialog.locator('.history-item').first()).toContainText('Current')
  await expect(dialog.getByRole('button', { name: 'Restore version' })).toBeDisabled()
  await dialog.getByRole('button', { name: 'Close' }).click()

  await page.getByTestId('page-title').click()
  await page.keyboard.press('End')
  await page.keyboard.type(' final')
  await rowAction(page, 'Essay final', 'Move to')
  const picker = page.getByRole('dialog', { name: 'Move page to' })
  await picker.getByRole('textbox').fill('Drafts')
  await expect(picker.locator('.search-item-title')).toHaveText(['Drafts'])
  await page.keyboard.press('Enter')
  const file = join(workspace, 'Drafts', 'Essay final.md')
  await waitForFile(file, 'then rewritten')

  await openHistory(page)
  await dialog.locator('.history-item').last().click()
  await expect(dialog.locator('.history-preview')).toContainText('First draft')
  await expect(dialog.locator('.history-preview')).not.toContainText('rewritten')
  await dialog.getByRole('button', { name: 'Restore version' }).click()
  const confirm = page.getByRole('dialog', { name: /^Restore the version from/ })
  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  await expect(confirm.locator(':focus')).toHaveCount(1)
  await confirm.getByRole('button', { name: 'Restore' }).click()

  await expect(page.locator(editor)).toHaveText(/^First draftSee Notes\.$/)
  await expect(page.getByTestId('page-title')).toHaveText('Essay final')
  // The link was written relative to the page's old folder and must still reach Notes.
  await waitForFile(file, /\n\nFirst draft\n\nSee \[Notes\]\(\.\.\/Notes\.md\)\.\n$/)
  await expect(access(join(workspace, 'Essay.md'))).rejects.toThrow()
})

test('an outside edit keeps the replaced text as a version to restore', async ({ nb }) => {
  const { page, workspace } = nb
  await newPage(page, 'Shared')
  await page.keyboard.type('Mine')
  const file = join(workspace, 'Shared.md')
  await waitForFile(file, 'Mine')
  await writeFile(file, `${await frontmatter(file)}\nTheirs\n`)
  await expect(page.locator(editor)).toHaveText('Theirs')

  await openHistory(page)
  const dialog = page.getByRole('dialog', { name: 'Page history' })
  await expect(dialog.locator('.history-item')).toHaveCount(2)
  await dialog.locator('.history-item').nth(1).click()
  await expect(dialog.locator('.history-preview')).toContainText('Mine')
  await expect(dialog.locator('.history-preview')).not.toContainText('Theirs')
  await restore(page)
  await expect(page.locator(editor)).toHaveText('Mine')
  await waitForFile(file, /\n\nMine\n$/)
})
