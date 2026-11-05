import { utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from './fixtures'
import { editor, newPage, openFile, placeCaret, pressInEditor, waitForFile } from './helpers'

test('@ links a page as a mention that opens it', async ({ nbWith }) => {
  const nb = await nbWith({ files: { 'Roadmap.md': '---\nicon: 🗺️\n---\n\nplan\n' } })
  const { page } = nb
  await expect(page.getByTestId('sidebar-row-Roadmap')).toBeVisible()
  await newPage(page, 'Notes')
  await page.keyboard.type('See @road')
  await expect(page.locator('.page-picker .menu-item-label').first()).toHaveText('Roadmap')
  await page.keyboard.press('Enter')
  const chip = page.locator(`${editor} .nb-mention`)
  await expect(chip).toHaveText('🗺️Roadmap')
  await waitForFile(join(nb.workspace, 'Notes.md'), 'See [Roadmap](Roadmap.md "mention")')
  await chip.click()
  await expect(page.getByTestId('page-title')).toHaveText('Roadmap')
})

test('[[ opens the same picker and can create a page', async ({ nb }) => {
  const { page } = nb
  await newPage(page, 'Hub')
  await page.keyboard.type('[[Brand new')
  const create = page.locator('.page-picker .menu-item', { hasText: 'New page' })
  await expect(create).toContainText('Brand new')
  await create.click()
  await expect(page.locator(`${editor} .nb-mention`)).toHaveText(/Brand new/)
  await expect(page.getByTestId('sidebar-row-Brand new')).toBeVisible()
  const saved = await waitForFile(join(nb.workspace, 'Hub.md'), '"mention")')
  expect(saved).toContain('[Brand new](Hub/Brand%20new.md "mention")')
  expect(saved).not.toContain('[[')
})

test('a mention shows the new title after a rename, and goes grey when the page is deleted', async ({
  nbWith
}) => {
  const { page } = await openFile(nbWith, 'Source', 'Go to [Target](Target.md "mention")\n', {
    files: { 'Target.md': 't\n' }
  })
  const row = page.getByTestId('sidebar-row-Target')
  await row.hover()
  await row.getByRole('button', { name: 'Page actions' }).click()
  await page.getByRole('menuitem', { name: 'Rename' }).click()
  await page.keyboard.press('Meta+a')
  await page.keyboard.type('Renamed')
  await page.keyboard.press('Enter')
  await expect(page.locator(`${editor} .nb-mention`)).toHaveText(/Renamed/)
  const renamed = page.getByTestId('sidebar-row-Renamed')
  await renamed.hover()
  await renamed.getByRole('button', { name: 'Page actions' }).click()
  await page.getByRole('menuitem', { name: 'Move to Trash' }).click()
  await expect(page.locator(`${editor} .nb-mention`)).toHaveAttribute('data-missing', 'true')
})

test('@ inside an email address or before a space does not create pages', async ({ nb }) => {
  const { page } = nb
  await newPage(page, 'Mail')
  const rows = page.locator('[data-testid^="sidebar-row-"]')
  await expect(rows).toHaveCount(1)
  await page.keyboard.type('mail dale@easygo.io')
  await expect(page.locator('.page-picker')).toHaveCount(0)
  await page.keyboard.press('Enter')
  await page.keyboard.type('meet @ 5pm')
  await expect(page.locator('.page-picker')).toHaveCount(0)
  await page.keyboard.press('Enter')
  await expect(page.locator(`${editor} .bn-inline-content`)).toHaveText([
    'mail dale@easygo.io',
    'meet @ 5pm',
    ''
  ])
  await expect(page.locator(`${editor} .nb-mention`)).toHaveCount(0)
  const saved = await waitForFile(join(nb.workspace, 'Mail.md'), 'meet @ 5pm')
  expect(saved).not.toContain('"mention"')
  await expect(rows).toHaveCount(1)
})

test(
  'copied blocks paste back with their mentions, callouts and page links',
  { tag: '@clipboard' },
  async ({ nbWith }) => {
    const { page } = await openFile(
      nbWith,
      'Copy',
      'Go to [Target](Target.md "mention")\n\n> [!callout] 💡\n> Note\n\n[Target](Target.md "page")\n\nEnd\n',
      { files: { 'Target.md': 't\n' } }
    )
    const types = page.locator(`${editor} .bn-block-content`)
    await expect(types).toHaveCount(4)
    // A click on the first line would land on the mention and open it.
    const note = page.locator(`${editor} .bn-inline-content`, { hasText: 'Note' })
    await placeCaret(note)
    await page.keyboard.type('!')
    await expect(note).toContainText('!')
    await page.keyboard.press('Backspace')
    await page.keyboard.press('Escape')
    const selected = page.locator(`${editor} .nb-block-selected`)
    await expect(selected).toHaveText([/Note/])
    await page.keyboard.press('Shift+ArrowUp')
    await page.keyboard.press('Shift+ArrowDown')
    await expect(selected).toHaveCount(3)
    await page.keyboard.press('Meta+c')
    await page.keyboard.press('ArrowDown')
    await expect(selected).toHaveText(['End'])
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Meta+v')
    await expect
      .poll(() => types.evaluateAll((els) => els.map((el) => el.getAttribute('data-content-type'))))
      .toEqual([
        ...['paragraph', 'callout', 'pageLink', 'paragraph'],
        ...['paragraph', 'callout', 'pageLink']
      ])
    await expect(page.locator(`${editor} .nb-mention`)).toHaveCount(2)
  }
)

const LINKS = 'See [Target](Target.md "mention")\n\n[Target](Target.md "page")\n'

test('links come alive when the page they point to is added outside the app', async ({
  nbWith
}) => {
  const nb = await openFile(nbWith, 'Home', LINKS)
  const { page } = nb
  const missing = page.locator(`${editor} [data-missing]`)
  await expect(missing).toHaveCount(2)
  await writeFile(join(nb.workspace, 'Target.md'), 't\n')
  await expect(page.getByTestId('sidebar-row-Target')).toBeVisible()
  await expect(missing).toHaveCount(0)
  // The left edge, as the middle of this short line is the mention, which opens its page.
  await page
    .locator(`${editor} .bn-inline-content`, { hasText: 'See' })
    .click({ position: { x: 1, y: 8 } })
  await pressInEditor(page, 'End')
  await page.keyboard.type('!')
  const saved = await waitForFile(join(nb.workspace, 'Home.md'), '!')
  expect(saved).toContain('[Target](Target.md "mention")')
  expect(saved).toContain('[Target](Target.md "page")')
  await page.locator(`${editor} .nb-page-link`).click()
  await expect(page.getByRole('heading', { level: 1, name: 'Target' })).toBeVisible()
})

test('links to a page written just before launch work on the page opened first', async ({ nb }) => {
  const home = join(nb.workspace, 'Home.md')
  await writeFile(home, LINKS)
  const settled = new Date(Date.now() - 60_000)
  await utimes(home, settled, settled)
  // Written moments before launch, so the app waits for it to settle before adding it.
  await writeFile(join(nb.workspace, 'Target.md'), 't\n')
  const page = await nb.relaunch()
  await page.getByTestId('sidebar-row-Home').click()
  await expect(page.locator(`${editor} .nb-mention`)).toHaveCount(1)
  await expect(page.getByTestId('sidebar-row-Target')).toBeVisible()
  await expect(page.locator(`${editor} [data-missing]`)).toHaveCount(0)
})
