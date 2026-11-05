import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, test } from './fixtures'
import { editor, newPage, openFile, placeCaret, waitForFile } from './helpers'

test('the slash menu looks like Notion, and no results then a space closes it', async ({ nb }) => {
  const { page } = nb
  await newPage(page, 'Slash')
  await page.keyboard.type('/')
  const menu = page.locator('.slash-menu')
  await expect(menu).toBeVisible()
  await expect(menu.locator('.menu-section').first()).toHaveText('Basic blocks')
  const items = menu.locator('.menu-item')
  await expect(items.first().locator('.menu-item-label')).toHaveText('Text')
  await expect(
    menu.getByRole('option', { name: /^Heading 1/ }).locator('.menu-item-hint')
  ).toHaveText('#')
  await expect(
    menu.getByRole('option', { name: /To-do list/ }).locator('.menu-item-hint')
  ).toHaveText('[]')
  await expect
    .poll(
      () => items.evaluateAll((els) => els.every((el) => el.getBoundingClientRect().height === 28)),
      'every item is 28px tall'
    )
    .toBe(true)
  await expect(menu).not.toContainText('⌘')
  await expect(menu.locator('.slash-menu-footer')).toContainText("Type '/' on the page")
  await expect.poll(async () => (await menu.boundingBox())?.width).toBe(324)
  await page.keyboard.type('zzzz')
  await expect(menu.locator('.menu-empty')).toHaveText('No results')
  await page.keyboard.type(' ')
  await expect(menu).toBeHidden()
  await expect(page.locator(editor)).toContainText('/zzzz')
})

test('typing filters, hovering moves the highlight, and Enter turns the block into the highlighted choice', async ({
  nb
}) => {
  const { page } = nb
  await newPage(page, 'Filter')
  await page.keyboard.type('/head')
  await expect(page.locator('.slash-menu .menu-item-label')).toHaveText([
    'Heading 1',
    'Heading 2',
    'Heading 3',
    'Toggle heading 1',
    'Toggle heading 2',
    'Toggle heading 3'
  ])
  await page.keyboard.press('ArrowDown')
  const active = page.locator('.slash-menu .menu-item.active')
  await expect(active).toHaveText(/Heading 2/)
  await page.locator('.slash-menu').getByRole('option', { name: 'Heading 1', exact: true }).hover()
  await expect(active).toHaveCount(1)
  await expect(active).toHaveText(/Heading 1/)
  await page.keyboard.press('ArrowDown')
  await expect(active).toHaveText(/Heading 2/)
  await page.keyboard.press('Enter')
  await page.keyboard.type('Picked')
  await waitForFile(join(nb.workspace, 'Filter.md'), '## Picked')
})

test('the whole menu stays on screen mid-window, and flips above the cursor at the bottom', async ({
  nbWith
}) => {
  const body = Array.from({ length: 80 }, (_, i) => `Line ${i}`).join('\n\n') + '\n'
  const { page } = await openFile(nbWith, 'Long', body)
  const height = await page.evaluate(() => innerHeight)
  const footer = page.locator('.slash-menu-footer')
  for (const room of [320, 360, 400]) {
    const line = page.locator(`${editor} .bn-block-content`, { hasText: /^Line 40$/ })
    await line.evaluate((el, gap) => {
      const scroller = document.querySelector('[data-testid="page-scroll"]')!
      const r = el.getBoundingClientRect()
      scroller.scrollTop += r.bottom - (innerHeight - gap)
    }, room)
    await placeCaret(line)
    await page.keyboard.type(' /')
    await expect(footer).toBeVisible()
    await expect
      .poll(async () => {
        const box = await footer.boundingBox()
        return box && box.y + box.height <= height
      }, `menu fits with ${room}px below the line`)
      .toBe(true)
    await page.keyboard.press('Escape')
    await expect(footer).toBeHidden()
    await page.keyboard.press('Backspace')
    await page.keyboard.press('Backspace')
    await expect(line).toHaveText('Line 40')
  }

  const last = page.locator(`${editor} .bn-block-content`).last()
  await last.scrollIntoViewIfNeeded()
  // Clicking a block's empty right side puts the cursor at its end; End would scroll the page on macOS.
  await placeCaret(last)
  await page.keyboard.press('Enter')
  await page.keyboard.type('/')
  const menu = page.locator('.slash-menu')
  await expect(menu).toBeVisible()
  await expect
    .poll(async () => {
      const box = await menu.boundingBox()
      return box && box.y >= 0 && box.y + box.height <= height
    }, 'menu at the bottom flips above the cursor')
    .toBe(true)
})

test('the highlight survives the app updating while the menu is open', async ({ nb }) => {
  const { page } = nb
  await newPage(page, 'Steady')
  await page.keyboard.type('/')
  await page.locator('.slash-menu').getByRole('option', { name: 'Heading 3', exact: true }).hover()
  // Off the menu, so no hover can put back a highlight the update reset.
  await page.mouse.move(0, 0)
  const active = page.locator('.slash-menu .menu-item.active')
  await expect(active).toHaveText(/Heading 3/)
  // A new page re-renders the editor, which hands BlockNote a fresh item loader.
  await writeFile(join(nb.workspace, 'Arrived.md'), 'new\n')
  await expect(page.getByTestId('sidebar-row-Arrived')).toBeVisible()
  // The fresh loader resolves in microtasks, so its items have rendered by the second frame.
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
  )
  await expect(active).toHaveText(/Heading 3/)
  await page.keyboard.press('Enter')
  await page.keyboard.type('Kept')
  await waitForFile(join(nb.workspace, 'Steady.md'), '### Kept')
})
