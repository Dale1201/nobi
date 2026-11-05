import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from './fixtures'
import { newPage } from './helpers'

test('page actions menu works from the keyboard and the mouse, and Escape closes it', async ({
  nb
}) => {
  const { page } = nb
  await newPage(page, 'Alpha')
  const row = page.getByTestId('sidebar-row-Alpha')
  const openMenu = async (): Promise<void> => {
    await row.hover()
    await row.getByRole('button', { name: 'Page actions' }).click()
  }
  await openMenu()
  const menu = page.getByRole('menu')
  const active = menu.locator('.menu-item.active .menu-item-label')
  await menu.getByRole('menuitem', { name: 'Rename' }).hover()
  await expect(active).toHaveText('Rename')
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()

  await openMenu()
  await expect(active).toHaveText('Add to Favorites')
  await page.keyboard.press('ArrowDown')
  await expect(active).toHaveText('Duplicate')
  await page.keyboard.press('Enter')
  await expect(menu).toBeHidden()
  await expect(page.getByTestId('sidebar-row-Alpha (1)')).toBeVisible()
})

test('a menu near the window edge stays on screen and keeps its highlight as the app updates', async ({
  nb
}) => {
  const { page } = nb
  await newPage(page, 'Gamma')
  await page.getByRole('button', { name: 'Page menu' }).click()
  const menu = page.getByRole('menu')
  await expect
    .poll(async () => {
      const box = (await menu.boundingBox())!
      const size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
      return box.x + box.width <= size.width && box.y + box.height <= size.height
    })
    .toBe(true)

  const active = menu.locator('.menu-item.active .menu-item-label')
  await page.keyboard.press('ArrowDown')
  await expect(active).toHaveText('Move to')
  await writeFile(join(nb.workspace, 'Arrived.md'), 'new\n')
  await expect(page.getByTestId('sidebar-row-Arrived')).toBeVisible()
  await expect(active).toHaveText('Move to')
})

test('the trash popover and icon picker keep their own widths', async ({ nb }) => {
  const { page } = nb
  await newPage(page, 'Widths')
  await page.getByRole('button', { name: 'Trash', exact: true }).click()
  await expect
    .poll(async () => (await page.locator('.menu.trash-popover').boundingBox())?.width)
    .toBe(414)
  await page.keyboard.press('Escape')
  await page.getByTestId('page-title').hover()
  await page.getByRole('button', { name: 'Add icon' }).click()
  await page.getByTestId('page-icon').click()
  await expect
    .poll(async () => {
      const panel = await page.locator('.menu.icon-picker').boundingBox()
      const picker = await page.locator('.nb-icon-picker').boundingBox()
      return Boolean(panel && picker && panel.width >= picker.width)
    })
    .toBe(true)
})
