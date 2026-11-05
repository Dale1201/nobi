import { access } from 'node:fs/promises'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test, type AppFixture, type Seed } from './fixtures'
import { menu, waitForFile } from './helpers'

type NbWith = (seed: Seed) => Promise<AppFixture>

async function nestedWorkspace(nbWith: NbWith): Promise<AppFixture> {
  const nb = await nbWith({
    files: {
      'Top.md': 'top\n',
      'Top/Middle.md': 'middle\n',
      'Top/Middle/Deep.md': 'deep\n',
      'Linker.md': '[Deep](Top/Middle/Deep.md "page")\n'
    }
  })
  await expect(nb.page.getByTestId('sidebar-row-Top')).toBeVisible()
  return nb
}

const forty = Object.fromEntries(
  Array.from({ length: 40 }, (_, i) => [`Page ${String(i).padStart(2, '0')}.md`, 'x\n'])
)

async function search(page: Page, text: string): Promise<void> {
  await page.getByRole('button', { name: 'Search' }).first().click()
  const dialog = page.getByRole('dialog', { name: 'Search' })
  await dialog.getByRole('textbox').fill(text)
  await expect(dialog.locator('.search-item-title').first()).toHaveText(text)
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('page-title')).toHaveText(text)
}

/** Lets React effects of the last render, such as a row scrolling itself into view, run. */
async function nextFrames(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
  )
}

test('the expand arrow shows on hover, and search reveals and highlights a nested page even after its parent is collapsed', async ({
  nbWith
}) => {
  const { page } = await nestedWorkspace(nbWith)
  const top = page.getByTestId('sidebar-row-Top')
  const arrow = top.getByRole('button', { name: 'Expand' })
  await page.mouse.move(800, 600)
  await expect(arrow).toBeHidden()
  await expect(top.locator('.page-icon')).toBeVisible()
  await top.hover()
  await expect(arrow).toBeVisible()
  await expect(top.locator('.page-icon')).toBeHidden()

  await expect(page.getByTestId('sidebar-row-Deep')).toBeHidden()
  await search(page, 'Deep')
  await expect(page.getByTestId('sidebar-row-Middle')).toBeVisible()
  await expect(page.getByTestId('sidebar-row-Deep')).toHaveClass(/active/)

  await top.hover()
  await top.getByRole('button', { name: 'Collapse' }).click()
  await expect(page.getByTestId('sidebar-row-Deep')).toBeHidden()
  await search(page, 'Deep')
  await expect(page.getByTestId('sidebar-row-Deep')).toHaveClass(/active/)
})

test('following a link reveals the page, and Back reveals it again after its parent was collapsed', async ({
  nbWith
}) => {
  const nb = await nestedWorkspace(nbWith)
  const { page } = nb
  await page.getByTestId('sidebar-row-Linker').click()
  await page.locator('.nb-page-link').click()
  await expect(page.getByTestId('sidebar-row-Deep')).toHaveClass(/active/)

  await page.getByTestId('sidebar-row-Linker').click()
  await expect(page.getByTestId('page-title')).toHaveText('Linker')
  const top = page.getByTestId('sidebar-row-Top')
  await top.hover()
  await top.getByRole('button', { name: 'Collapse' }).click()
  await expect(page.getByTestId('sidebar-row-Deep')).toBeHidden()
  await menu(nb.app, 'Back')
  await expect(page.getByTestId('sidebar-row-Deep')).toHaveClass(/active/)
})

test('favorites expand on their own, and + on a favorite adds the page inside it', async ({
  nbWith
}) => {
  const { page } = await nbWith({ files: { 'Starred.md': 's\n', 'Starred/Child.md': 'c\n' } })
  const pagesRow = page.getByTestId('sidebar-row-Starred')
  await pagesRow.hover()
  await pagesRow.getByRole('button', { name: 'Page actions' }).click()
  await page.getByRole('menuitem', { name: 'Add to Favorites' }).click()
  const favorites = page.locator('.sidebar-section', { hasText: 'Favorites' })
  const favRow = favorites.getByTestId('sidebar-row-Starred')
  await favRow.hover()
  await favRow.getByRole('button', { name: 'Expand' }).click()
  await expect(favorites.getByTestId('sidebar-row-Child')).toBeVisible()
  const pages = page.locator('.sidebar-section', { hasText: 'Pages' })
  await expect(pages.getByTestId('sidebar-row-Child')).toBeHidden()

  await favRow.hover()
  await favRow.getByRole('button', { name: 'Collapse' }).click()
  await expect(favorites.getByTestId('sidebar-row-Child')).toBeHidden()
  await favRow.hover()
  await favRow.getByRole('button', { name: 'Add a page inside' }).click()
  await expect(favorites.getByTestId('sidebar-row-Untitled')).toBeVisible()
})

test('a page without sub-pages says so when expanded', async ({ nbWith }) => {
  const { page } = await nbWith({ files: { 'Leaf.md': 'l\n' } })
  const row = page.getByTestId('sidebar-row-Leaf')
  await row.hover()
  await row.getByRole('button', { name: 'Expand' }).click()
  await expect(page.locator('.sidebar-empty')).toHaveText('No pages inside')
})

test('holding a dragged page over a collapsed page opens it, and dropping nests and links it', async ({
  nbWith
}) => {
  const nb = await nbWith({
    files: { 'Folder.md': 'f\n', 'Folder/Inside.md': 'i\n', 'Mover.md': 'm\n' }
  })
  const { page } = nb
  await page.getByTestId('sidebar-row-Mover').hover()
  await page.mouse.down()
  const box = (await page.getByTestId('sidebar-row-Folder').boundingBox())!
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y, { steps: 5 })
  await expect(page.getByTestId('sidebar-row-Inside')).toBeVisible()
  await page.mouse.move(x + 2, y, { steps: 2 })
  await page.mouse.up()
  await expect
    .poll(() =>
      access(join(nb.workspace, 'Folder', 'Mover.md')).then(
        () => true,
        () => false
      )
    )
    .toBe(true)
  await waitForFile(join(nb.workspace, 'Folder.md'), '[Mover](Folder/Mover.md "page")')
})

test('the sidebar scrolls while a page is dragged near its bottom edge', async ({ nbWith }) => {
  const { page } = await nbWith({ files: forty })
  const scroller = page.locator('.sidebar-scroll')
  await expect(page.getByTestId('sidebar-row-Page 39')).toBeAttached()
  await page.getByTestId('sidebar-row-Page 00').hover()
  await page.mouse.down()
  const box = (await scroller.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - 10, { steps: 5 })
  for (let i = 0; i < 10; i++)
    await page.mouse.move(box.x + box.width / 2 + (i % 2), box.y + box.height - 10)
  await expect.poll(() => scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
  await page.mouse.up()
})

test('starring the current page does not move the sidebar', async ({ nbWith }) => {
  const { page } = await nbWith({ files: forty })
  const scroller = page.locator('.sidebar-scroll')
  await expect(page.getByTestId('sidebar-row-Page 39')).toBeAttached()
  await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight))
  await page.getByTestId('sidebar-row-Page 39').click()
  await expect(page.getByTestId('page-title')).toHaveText('Page 39')
  const row = page
    .locator('.sidebar-section', { hasText: 'Pages' })
    .getByTestId('sidebar-row-Page 39')
  const before = (await row.boundingBox())!.y
  await page.getByRole('button', { name: 'Add to Favorites' }).click()
  await expect(
    page.locator('.sidebar-section', { hasText: 'Favorites' }).getByTestId('sidebar-row-Page 39')
  ).toBeVisible()
  await nextFrames(page)
  // Scroll anchoring may raise scrollTop by the new section's height; the row itself stays put.
  expect(Math.abs((await row.boundingBox())!.y - before)).toBeLessThanOrEqual(1)
})

test('the current row scrolls into view, and clicking a favorite of a nested page keeps the favorite in view', async ({
  nbWith
}) => {
  const { page } = await nbWith({
    files: { ...forty, 'Zzz.md': 'z\n', 'Zzz/Target.md': 'target\n' }
  })
  await expect(page.getByTestId('sidebar-row-Zzz')).toBeAttached()
  await search(page, 'Target')
  await expect(page.getByTestId('sidebar-row-Target')).toBeInViewport()

  await page.getByRole('button', { name: 'Add to Favorites' }).click()
  const pages = page.locator('.sidebar-section', { hasText: 'Pages' })
  const zzz = pages.getByTestId('sidebar-row-Zzz')
  await zzz.hover()
  await zzz.getByRole('button', { name: 'Collapse' }).click()
  await page.getByTestId('sidebar-row-Page 00').click()
  await page.locator('.sidebar-scroll').evaluate((el) => (el.scrollTop = 0))
  const favorite = page
    .locator('.sidebar-section', { hasText: 'Favorites' })
    .getByTestId('sidebar-row-Target')
  await favorite.click()
  await expect(page.getByTestId('page-title')).toHaveText('Target')
  // Opening the page expands its parent in the page tree, which must not scroll the favorite away.
  await expect(pages.getByTestId('sidebar-row-Target')).toBeVisible()
  await nextFrames(page)
  await expect(favorite).toBeInViewport()
})
