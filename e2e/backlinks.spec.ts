import { expect, test } from './fixtures'
import { activePane, caretToLineEnd, editor, newTab, placeCaret } from './helpers'

test('a mention typed in another tab shows up as a backlink that opens its page', async ({
  nbWith
}) => {
  const nb = await nbWith({ files: { 'Target.md': 'the target\n', 'Notes.md': 'some notes\n' } })
  const { page } = nb
  await page.getByTestId('sidebar-row-Target').click()
  await expect(activePane(page).getByTestId('page-title')).toHaveText('Target')
  await expect(activePane(page).getByTestId('backlinks-button')).toHaveCount(0)

  await newTab(nb.app, page)
  await page.getByTestId('sidebar-row-Notes').click()
  await expect(activePane(page).getByTestId('page-title')).toHaveText('Notes')
  await placeCaret(activePane(page).locator(editor).getByText('some notes'))
  await caretToLineEnd(page)
  await page.keyboard.type(' @Targ')
  await expect(page.locator('.page-picker .menu-item-label').first()).toHaveText('Target')
  await page.keyboard.press('Enter')
  await expect(activePane(page).locator(`${editor} .nb-mention`)).toHaveText(/Target/)

  await page.locator('.tab').first().click()
  await expect(activePane(page).getByTestId('page-title')).toHaveText('Target')
  await expect(activePane(page).getByTestId('backlinks-button')).toHaveText('1 backlink')
  await activePane(page).getByTestId('backlinks-button').click()
  await page.getByTestId('backlink-Notes').click()
  await expect(activePane(page).getByTestId('page-title')).toHaveText('Notes')
})
