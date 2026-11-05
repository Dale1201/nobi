import { join } from 'node:path'
import { expect, test } from './fixtures'
import {
  caretToLineEnd,
  editor,
  openFile,
  placeCaret,
  rowAction,
  typeNewPageTitle,
  waitForFile
} from './helpers'

test('a page added inside another from the sidebar shows as a link at the end of its parent', async ({
  nbWith
}) => {
  const nb = await nbWith({ files: { 'Aztec.md': 'First idea\n' } })
  const { page } = nb
  const row = page.getByTestId('sidebar-row-Aztec')
  await row.hover()
  await row.getByRole('button', { name: 'Add a page inside' }).click()
  await typeNewPageTitle(page, 'Subpage')
  await waitForFile(
    join(nb.workspace, 'Aztec.md'),
    'First idea\n\n[Subpage](Aztec/Subpage.md "page")'
  )
  await row.click()
  const link = page.locator(`${editor} .nb-page-link`)
  await expect(link.locator('.nb-page-link-title')).toHaveText('Subpage')
  await expect(link.locator('.nb-page-link-icon svg')).toBeVisible()
  await expect(page.locator(`${editor} .bn-block-content`).last()).toHaveAttribute(
    'data-content-type',
    'pageLink'
  )
  await link.click()
  await expect(page.getByTestId('page-title')).toHaveText('Subpage')
})

test('typing in the parent right before adding a page keeps both the text and the link', async ({
  nbWith
}) => {
  const nb = await openFile(nbWith, 'Aztec', 'First idea\n')
  const { page } = nb
  await placeCaret(page.locator(editor).getByText('First idea'))
  await caretToLineEnd(page)
  await page.keyboard.type(' and more')
  const row = page.getByTestId('sidebar-row-Aztec')
  await row.hover()
  await row.getByRole('button', { name: 'Add a page inside' }).click()
  await typeNewPageTitle(page, 'Subpage')
  await waitForFile(
    join(nb.workspace, 'Aztec.md'),
    'First idea and more\n\n[Subpage](Aztec/Subpage.md "page")'
  )
  await page.getByRole('button', { name: 'Back' }).click()
  await expect(page.locator(`${editor} .nb-page-link-title`)).toHaveText('Subpage')
  await expect(page.locator(editor)).toContainText('First idea and more')
  await expect(page.getByText('This page was changed outside Nobsidian.')).toHaveCount(0)
})

test('a parent open in another tab shows the new sub-page link without a conflict', async ({
  nbWith
}) => {
  const nb = await openFile(nbWith, 'Aztec', 'First idea\n')
  const { page } = nb
  await placeCaret(page.locator(editor).getByText('First idea'))
  await caretToLineEnd(page)
  await page.keyboard.type(' and more')
  await page.getByRole('button', { name: 'New tab' }).click()
  const row = page.getByTestId('sidebar-row-Aztec')
  await row.hover()
  await row.getByRole('button', { name: 'Add a page inside' }).click()
  const title = page.getByTestId('page-title').locator('visible=true')
  await expect(title).toBeFocused()
  await page.keyboard.type('Subpage')
  await expect(page.getByTestId('sidebar-row-Subpage')).toBeVisible()
  await page.getByRole('tab').first().click()
  const shown = page.locator(editor).locator('visible=true')
  await expect(shown.locator('.nb-page-link-title')).toHaveText('Subpage')
  await expect(shown).toContainText('First idea and more')
  await expect(page.getByText('This page was changed outside Nobsidian.')).toHaveCount(0)
})

test('deleting a sub-page removes its link from the parent, and restoring puts it and its sub-pages back', async ({
  nbWith
}) => {
  const nb = await nbWith({
    files: {
      'Plan.md': 'Before\n\n[Step](Plan/Step.md "page")\n\nAfter\n',
      'Plan/Step.md': 's\n\n[Detail](Step/Detail.md "page")\n',
      'Plan/Step/Detail.md': 'd\n'
    }
  })
  const { page } = nb
  await page.getByTestId('sidebar-row-Plan').click()
  await page.getByTestId('sidebar-row-Plan').getByRole('button', { name: 'Expand' }).click()
  const shown = page.locator(editor)
  await expect(shown.locator('.nb-page-link-title')).toHaveText('Step')
  const step = page.getByTestId('sidebar-row-Step')
  await step.hover()
  await step.getByRole('button', { name: 'Expand' }).click()
  await expect(page.getByTestId('sidebar-row-Detail')).toBeVisible()
  await rowAction(page, 'Step', 'Move to Trash')
  await expect(page.getByTestId('sidebar-row-Detail')).toHaveCount(0)
  await expect(shown.locator('.nb-page-link')).toHaveCount(0)
  await expect(shown).toContainText('Before')
  await expect(shown).toContainText('After')
  await waitForFile(join(nb.workspace, 'Plan.md'), 'Before\n\nAfter\n')
  await expect(page.getByText('This page was changed outside Nobsidian.')).toHaveCount(0)

  await page.getByRole('button', { name: 'Trash', exact: true }).click()
  await page.getByTestId('trash-item-Step').click()
  await page.getByRole('button', { name: 'Restore page' }).click()
  await expect(page.getByTestId('page-title')).toHaveText('Step')
  await expect(shown.locator('.nb-page-link-title')).toHaveText('Detail')
  await expect(page.getByTestId('sidebar-row-Detail')).toBeVisible()
  await waitForFile(
    join(nb.workspace, 'Plan.md'),
    'Before\n\n[Step](Plan/Step.md "page")\n\nAfter\n'
  )
  await page.getByTestId('sidebar-row-Plan').click()
  await expect(shown.locator('.nb-page-link-title')).toHaveText('Step')
})

test('restoring a sub-page right after typing in its parent keeps both the text and the link', async ({
  nbWith
}) => {
  const nb = await nbWith({
    files: { 'Plan.md': 'Before\n\n[Step](Plan/Step.md "page")\n', 'Plan/Step.md': 's\n' }
  })
  const { page } = nb
  await page.getByTestId('sidebar-row-Plan').click()
  await page.getByTestId('sidebar-row-Plan').getByRole('button', { name: 'Expand' }).click()
  await rowAction(page, 'Step', 'Move to Trash')
  await waitForFile(join(nb.workspace, 'Plan.md'), /---\n\nBefore\n$/)
  // The open page reloads without the link, remounting the editor; a click before that loses focus.
  await expect(page.locator(`${editor} .nb-page-link-title`)).toHaveCount(0)
  await placeCaret(page.locator(editor).getByText('Before'))
  await caretToLineEnd(page)
  await page.keyboard.type(' typed')
  await page.getByRole('button', { name: 'Trash', exact: true }).click()
  await page.getByTestId('trash-item-Step').getByRole('button', { name: 'Restore' }).click()
  await waitForFile(join(nb.workspace, 'Plan.md'), 'Before typed\n\n[Step](Plan/Step.md "page")\n')
  await page.getByTestId('sidebar-row-Plan').click()
  await expect(page.locator(`${editor} .nb-page-link-title`)).toHaveText('Step')
  await expect(page.getByText('This page was changed outside Nobsidian.')).toHaveCount(0)
})
