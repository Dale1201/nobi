import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from './fixtures'
import { editor, menu, rowAction } from './helpers'

test('a deleted page opens read-only from Trash and can be restored', async ({ nbWith }) => {
  const nb = await nbWith({
    files: {
      'Plans.md': '---\nicon: 🗂️\n---\n\nKeep this safe.\n',
      'Plans/Child.md': 'Inner.\n',
      'Other.md': 'Other page.\n'
    }
  })
  const { page } = nb
  await rowAction(page, 'Plans', 'Move to Trash')
  await expect(page.getByTestId('sidebar-row-Plans')).toHaveCount(0)

  await page.getByRole('button', { name: 'Trash', exact: true }).click()
  const item = page.getByTestId('trash-item-Plans')
  await expect(item).toContainText('Top level')
  await item.click()
  await expect(page.getByRole('status')).toContainText('This page is in Trash.')
  await expect(page.locator(editor)).toContainText('Keep this safe.')
  await expect(page.locator(editor)).toHaveAttribute('contenteditable', 'false')
  await expect(page.locator('.sidebar-row.active')).toHaveCount(0)

  await page.getByRole('button', { name: 'Restore page' }).click()
  await expect(page.getByTestId('sidebar-row-Plans')).toBeVisible()
  await expect(page.getByTestId('page-title')).toHaveText('Plans')
  // The child comes back nested: hidden until its restored parent is expanded.
  const plans = page.getByTestId('sidebar-row-Plans')
  await expect(page.getByTestId('sidebar-row-Child')).toBeHidden()
  await plans.hover()
  await plans.getByRole('button', { name: 'Expand' }).click()
  await expect(page.getByTestId('sidebar-row-Child')).toBeVisible()
  await expect.poll(() => readdir(join(nb.workspace, 'Plans'))).toEqual(['Child.md'])
  await expect.poll(() => readdir(join(nb.workspace, '.nobsidian', 'trash'))).toEqual([])
})

test('a trashed page keeps a way back to the sidebar, and delete forever asks first', async ({
  nbWith
}) => {
  const nb = await nbWith({ files: { 'Scratch.md': 'Temporary.\n', 'Other.md': 'Other page.\n' } })
  const { page } = nb
  await rowAction(page, 'Scratch', 'Move to Trash')
  await page.getByRole('button', { name: 'Trash', exact: true }).click()
  await page.getByTestId('trash-item-Scratch').click()
  await expect(page.getByRole('status')).toContainText('This page is in Trash.')
  await menu(nb.app, 'Toggle Sidebar')
  await expect(page.getByTestId('sidebar')).toHaveCount(0)
  await page.getByRole('button', { name: 'Show sidebar' }).click()
  await expect(page.getByTestId('sidebar')).toBeVisible()

  await page.getByRole('button', { name: 'Trash', exact: true }).click()
  await page
    .getByTestId('trash-item-Scratch')
    .getByRole('button', { name: 'Delete forever' })
    .click()
  const confirm = page.getByRole('dialog', { name: 'Permanently delete "Scratch"?' })
  await expect(confirm).toContainText("This can't be undone.")
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await page.keyboard.press('Meta+K')
  await expect(page.getByRole('dialog')).toHaveCount(1)
  await confirm.getByRole('button', { name: 'Delete forever' }).click()
  await expect.poll(() => readdir(join(nb.workspace, '.nobsidian', 'trash'))).toEqual([])
  await page.getByRole('button', { name: 'Trash', exact: true }).click()
  await expect(page.getByText('No pages in Trash')).toBeVisible()
})

test('back leaves a trashed page for the previous page', async ({ nbWith }) => {
  const nb = await nbWith({ files: { 'First.md': 'First page.\n', 'Second.md': 'Second page.\n' } })
  const { page } = nb
  await page.getByTestId('sidebar-row-First').click()
  await page.getByTestId('sidebar-row-Second').click()
  await rowAction(page, 'Second', 'Move to Trash')
  await page.getByRole('button', { name: 'Trash', exact: true }).click()
  await page.getByTestId('trash-item-Second').click()
  await expect(page.getByRole('status')).toContainText('This page is in Trash.')

  await menu(nb.app, 'Back')
  await expect(page.getByRole('status')).toHaveCount(0)
  await expect(page.getByTestId('page-title')).toHaveText('First')
})
