import { join } from 'node:path'
import { expect, test } from './fixtures'
import { editor, openFile, waitForFile } from './helpers'

test('the selection toolbar has Notion buttons in Notion order, each showing its shortcut', async ({
  nbWith
}) => {
  const { page } = await openFile(nbWith, 'Bar', 'Select these words\n')
  await page.locator(`${editor} .bn-inline-content`).first().dblclick()
  const toolbar = page.locator('.bn-formatting-toolbar')
  await expect(toolbar).toBeVisible()
  await expect
    .poll(() =>
      toolbar
        .locator('button')
        .evaluateAll((els) =>
          els.map((el) => el.getAttribute('aria-label') ?? el.textContent?.trim())
        )
    )
    .toEqual([
      'Ask AI',
      'Turn into',
      'Create link',
      'Bold',
      'Italic',
      'Underline',
      'Strike',
      'Code',
      'Colors'
    ])
  await expect(toolbar.getByRole('button', { name: 'Turn into' })).toHaveText(/Text/)
  await toolbar.getByRole('button', { name: 'Bold' }).hover()
  await expect(page.getByRole('tooltip')).toContainText('⌘B')
})

test('Turn into from the toolbar ignores typing while open and turns the block', async ({
  nbWith
}) => {
  const { page, workspace } = await openFile(nbWith, 'TurnBar', 'Promote me\n')
  await page.locator(`${editor} .bn-inline-content`).first().dblclick()
  await page.locator('.bn-formatting-toolbar').getByRole('button', { name: 'Turn into' }).click()
  await expect(page.getByRole('menu')).toBeVisible()
  await page.keyboard.type('xyz')
  await page.keyboard.press('Backspace')
  await expect(page.locator(`${editor} .bn-inline-content`).first()).toHaveText('Promote me')
  await expect(page.getByRole('menu')).toBeVisible()
  await page.getByRole('menuitem', { name: 'Heading 2', exact: true }).click()
  await waitForFile(join(workspace, 'TurnBar.md'), '## Promote me')
})
