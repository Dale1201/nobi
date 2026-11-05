import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from './fixtures'
import {
  caretToLineEnd,
  editor,
  placeCaret,
  rowAction,
  typeNewPageTitle,
  waitForFile
} from './helpers'

test('a page added inside another from the sidebar shows as a link at the end of its parent', async ({
  nb
}) => {
  await writeFile(join(nb.workspace, 'Aztec.md'), 'First idea\n')
  const page = await nb.relaunch()
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
  nb
}) => {
  await writeFile(join(nb.workspace, 'Aztec.md'), 'First idea\n')
  const page = await nb.relaunch()
  await page.getByTestId('sidebar-row-Aztec').click()
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
  nb
}) => {
  await writeFile(join(nb.workspace, 'Aztec.md'), 'First idea\n')
  const page = await nb.relaunch()
  await page.getByTestId('sidebar-row-Aztec').click()
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

test('moving a page moves its link from the old parent to the new one', async ({ nb }) => {
  await mkdir(join(nb.workspace, 'Old'))
  await writeFile(join(nb.workspace, 'Old.md'), 'Before\n\n[Child](Old/Child.md "page")\n\nAfter\n')
  await writeFile(join(nb.workspace, 'Old', 'Child.md'), 'c\n')
  await writeFile(join(nb.workspace, 'New.md'), 'Home\n')
  const page = await nb.relaunch()
  await page.getByTestId('sidebar-row-Old').hover()
  await page.getByTestId('sidebar-row-Old').getByRole('button', { name: 'Expand' }).click()
  await rowAction(page, 'Child', 'Move to')
  const picker = page.getByRole('dialog', { name: 'Move page to' })
  await picker.getByRole('textbox').fill('New')
  await picker.locator('.search-item-title', { hasText: 'New' }).click()
  await waitForFile(join(nb.workspace, 'New.md'), 'Home\n\n[Child](New/Child.md "page")')
  await waitForFile(join(nb.workspace, 'Old.md'), 'Before\n\nAfter\n')
  expect(await readFile(join(nb.workspace, 'Old.md'), 'utf8')).not.toContain('Child')
})

test('dragging a page onto another nests it and links it there', async ({ nb }) => {
  await writeFile(join(nb.workspace, 'Folder.md'), 'f\n')
  await writeFile(join(nb.workspace, 'Mover.md'), 'm\n')
  const page = await nb.relaunch()
  await page.getByTestId('sidebar-row-Mover').hover()
  await page.mouse.down()
  const box = (await page.getByTestId('sidebar-row-Folder').boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 })
  await page.mouse.up()
  await waitForFile(join(nb.workspace, 'Folder.md'), 'f\n\n[Mover](Folder/Mover.md "page")')
})

test('a duplicated sub-page is linked right after the original', async ({ nb }) => {
  await mkdir(join(nb.workspace, 'Plan'))
  await writeFile(join(nb.workspace, 'Plan.md'), '[Step](Plan/Step.md "page")\n\nNotes\n')
  await writeFile(join(nb.workspace, 'Plan', 'Step.md'), 's\n')
  const page = await nb.relaunch()
  await page.getByTestId('sidebar-row-Plan').hover()
  await page.getByTestId('sidebar-row-Plan').getByRole('button', { name: 'Expand' }).click()
  await rowAction(page, 'Step', 'Duplicate')
  await expect(page.getByTestId('page-title')).toHaveText('Step (1)')
  await waitForFile(
    join(nb.workspace, 'Plan.md'),
    /\[Step\]\(Plan\/Step\.md "page"\)\n\n\[Step \(1\)\]\(\S+ "page"\)\n\nNotes\n$/
  )
})

test('a sub-page made with /page is linked only once', async ({ nb }) => {
  await writeFile(join(nb.workspace, 'Parent.md'), 'Body\n')
  const page = await nb.relaunch()
  await page.getByTestId('sidebar-row-Parent').click()
  await placeCaret(page.locator(editor))
  await caretToLineEnd(page)
  await page.keyboard.press('Enter')
  await page.keyboard.type('/page')
  await page.keyboard.press('Enter')
  const text = await waitForFile(join(nb.workspace, 'Parent.md'), '"page")')
  expect(text.match(/"page"\)/g)).toHaveLength(1)
  await expect(page.locator(`${editor} .nb-page-link`)).toHaveCount(1)
})

test('deleting a sub-page removes its link from the parent, and restoring puts it back', async ({
  nb
}) => {
  await mkdir(join(nb.workspace, 'Plan'))
  await writeFile(join(nb.workspace, 'Plan.md'), 'Before\n\n[Step](Plan/Step.md "page")\n\nAfter\n')
  await writeFile(join(nb.workspace, 'Plan', 'Step.md'), 's\n')
  const page = await nb.relaunch()
  await page.getByTestId('sidebar-row-Plan').click()
  await page.getByTestId('sidebar-row-Plan').getByRole('button', { name: 'Expand' }).click()
  const shown = page.locator(editor)
  await expect(shown.locator('.nb-page-link-title')).toHaveText('Step')
  await rowAction(page, 'Step', 'Move to Trash')
  await expect(shown.locator('.nb-page-link')).toHaveCount(0)
  await expect(shown).toContainText('Before')
  await expect(shown).toContainText('After')
  await waitForFile(join(nb.workspace, 'Plan.md'), 'Before\n\nAfter\n')
  await expect(page.getByText('This page was changed outside Nobsidian.')).toHaveCount(0)

  await page.getByRole('button', { name: 'Trash', exact: true }).click()
  await page.getByTestId('trash-item-Step').click()
  await page.getByRole('button', { name: 'Restore page' }).click()
  await expect(page.getByTestId('page-title')).toHaveText('Step')
  await waitForFile(
    join(nb.workspace, 'Plan.md'),
    'Before\n\n[Step](Plan/Step.md "page")\n\nAfter\n'
  )
  await page.getByTestId('sidebar-row-Plan').click()
  await expect(shown.locator('.nb-page-link-title')).toHaveText('Step')
})

test('restoring a sub-page right after typing in its parent keeps both the text and the link', async ({
  nb
}) => {
  await mkdir(join(nb.workspace, 'Plan'))
  await writeFile(join(nb.workspace, 'Plan.md'), 'Before\n\n[Step](Plan/Step.md "page")\n')
  await writeFile(join(nb.workspace, 'Plan', 'Step.md'), 's\n')
  const page = await nb.relaunch()
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
