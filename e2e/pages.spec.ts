import { readdir, readFile, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { launchElectron } from './launch'
import {
  caretToLineEnd,
  caretToLineStart,
  editor,
  newPage,
  openFile,
  placeCaret,
  rowAction,
  waitForFile
} from './helpers'

test('duplicate copies a page and its sub-pages below the original', async ({ nbWith }) => {
  const nb = await nbWith({
    files: { 'Plan.md': 'Body\n', 'Plan/Step.md': 'Step one\n', 'Zebra.md': 'Last\n' }
  })
  const { page } = nb
  await rowAction(page, 'Plan', 'Duplicate')
  await expect(page.getByTestId('page-title')).toHaveText('Plan (1)')
  await expect(page.locator('.sidebar-section').last().locator('.sidebar-row-title')).toHaveText([
    'Plan',
    'Plan (1)',
    'Zebra',
    'New page'
  ])
  await expect(page.locator(editor)).toContainText('Body')
  await expect
    .poll(() => readdir(join(nb.workspace, 'Plan (1)')).catch(() => []))
    .toEqual(['Step.md'])
})

test('move to picks a new parent from a searchable list', async ({ nbWith }) => {
  const nb = await nbWith({
    files: { 'Inbox.md': 'Note\n', 'Projects.md': 'All projects\n', 'Archive.md': 'Old\n' }
  })
  const { page } = nb
  await rowAction(page, 'Inbox', 'Move to')
  const picker = page.getByRole('dialog', { name: 'Move page to' })
  await page.keyboard.press('Meta+k')
  await expect(picker).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'Search' })).toHaveCount(0)
  await expect(picker.locator('.search-item-title')).toHaveText([
    'Top level',
    'Archive',
    'Projects'
  ])
  await picker.getByRole('textbox').fill('proj')
  await expect(picker.locator('.search-item-title')).toHaveText(['Projects'])
  await page.keyboard.press('Enter')
  await expect
    .poll(() => readdir(join(nb.workspace, 'Projects')).catch(() => []))
    .toEqual(['Inbox.md'])
})

test('a table of contents lists the headings and jumps to them by click or keyboard', async ({
  nb
}) => {
  const { page, workspace } = nb
  await newPage(page, 'Guide')
  await page.keyboard.type('/toc')
  await page.keyboard.press('Enter')
  await expect(page.locator('.nb-toc-empty')).toHaveText(
    'Add headings to create a table of contents.'
  )
  await page.locator(editor).press('ArrowDown')
  await page.keyboard.type('# Intro')
  await page.keyboard.press('Enter')
  for (let i = 0; i < 40; i++) await page.keyboard.press('Enter')
  await page.keyboard.type('## Details')
  await expect(page.locator('.nb-toc-item')).toHaveText(['Intro', 'Details'])
  await waitForFile(join(workspace, 'Guide.md'), '<nav data-toc></nav>\n\n# Intro')

  const details = page.locator('h2', { hasText: 'Details' })
  const toTop = (): Promise<void> =>
    page.getByTestId('page-scroll').evaluate((el) => el.scrollTo(0, 0))
  await toTop()
  await expect(details).not.toBeInViewport()
  await page.locator('.nb-toc-item', { hasText: 'Details' }).click()
  await expect(details).toBeInViewport()

  await toTop()
  await expect(details).not.toBeInViewport()
  await page.locator('.nb-toc').getByRole('button', { name: 'Details' }).focus()
  await page.keyboard.press('Enter')
  await expect(details).toBeInViewport()
})

test('a table of contents follows heading edits', async ({ nb }) => {
  const { page } = nb
  await newPage(page, 'Live')
  await page.keyboard.type('/toc')
  await page.keyboard.press('Enter')
  await page.locator(editor).press('ArrowDown')
  await page.keyboard.type('# Intro')
  await expect(page.locator('.nb-toc-item')).toHaveText(['Intro'])
  await page.keyboard.type('duction')
  await expect(page.locator('.nb-toc-item')).toHaveText(['Introduction'])
  await page.keyboard.press('Shift+Meta+ArrowLeft')
  await page.keyboard.press('Backspace')
  await expect(page.locator('.nb-toc-item')).toHaveText(['Untitled'])
  await page.keyboard.press('Backspace')
  await expect(page.locator('.nb-toc-item')).toHaveCount(0)
  await expect(page.locator('.nb-toc-empty')).toBeVisible()
})

/** The editor reads the selection asynchronously; its toolbar shows exactly when it has. */
async function selectWordBeforeCursor(page: Page): Promise<void> {
  const toolbar = page.locator('[data-test="colors"]')
  await expect(toolbar).toBeHidden()
  await page.keyboard.press('Shift+Alt+ArrowLeft')
  await expect(toolbar).toBeVisible()
}

test('Cmd+Shift+H toggles the last color picked in the toolbar', async ({ nb }) => {
  const { page, workspace } = nb
  await newPage(page, 'Colors')
  await page.keyboard.type('alpha beta')
  // Saved means the editor has applied the typing, so it cannot reset the selection made next.
  await waitForFile(join(workspace, 'Colors.md'), 'alpha beta')
  await selectWordBeforeCursor(page)
  await page.keyboard.press('Meta+Shift+h')
  await waitForFile(join(workspace, 'Colors.md'), 'alpha <span data-bg="yellow">beta</span>')

  await caretToLineStart(page)
  await page.keyboard.press('Shift+Alt+ArrowRight')
  // "alpha" has no color yet, unlike the "beta" selected before.
  await expect(
    page.locator('[data-test="colors"] .bn-color-icon[data-background-color="default"]')
  ).toBeVisible()
  await page.locator('[data-test="colors"]').click()
  await page.locator('[data-test="text-color-red"]').click()
  await waitForFile(join(workspace, 'Colors.md'), '<span data-color="red">alpha</span>')

  await placeCaret(page.locator(editor).getByText('beta'))
  await caretToLineEnd(page)
  await page.keyboard.type(' gamma')
  await waitForFile(join(workspace, 'Colors.md'), 'gamma')
  await selectWordBeforeCursor(page)
  await page.keyboard.press('Meta+Shift+h')
  const file = join(workspace, 'Colors.md')
  await waitForFile(file, '<span data-color="red">gamma</span>')

  await page.keyboard.press('Meta+Shift+h')
  await expect.poll(() => readFile(file, 'utf8')).not.toContain('<span data-color="red">gamma')
  expect(await readFile(file, 'utf8')).toMatch(/<span data-color="red">alpha<\/span>.*gamma/)
})

test('the last picked color survives a restart', async ({ nb }) => {
  const { page, workspace, userData } = nb
  const file = join(workspace, 'Persist.md')
  await newPage(page, 'Persist')
  await page.keyboard.type('alpha beta')
  await waitForFile(file, 'alpha beta')
  await caretToLineStart(page)
  await page.keyboard.press('Shift+Alt+ArrowRight')
  await expect(page.locator('[data-test="colors"]')).toBeVisible()
  await page.locator('[data-test="colors"]').click()
  await page.locator('[data-test="text-color-red"]').click()
  await waitForFile(file, '<span data-color="red">alpha</span>')
  await waitForFile(join(userData, 'settings.json'), '"red"')

  const relaunched = await nb.relaunch()
  await placeCaret(relaunched.locator(editor).getByText('beta'))
  await caretToLineEnd(relaunched)
  await relaunched.keyboard.type(' gamma')
  await waitForFile(file, 'gamma')
  await selectWordBeforeCursor(relaunched)
  await relaunched.keyboard.press('Meta+Shift+h')
  await waitForFile(file, '<span data-color="red">gamma</span>')
})

test('clicking below the last block adds a line to type on, like Notion', async ({ nbWith }) => {
  const nb = await openFile(nbWith, 'Bottom', '- [ ] first\n- [ ] second\n')
  const { page } = nb
  const file = join(nb.workspace, 'Bottom.md')
  const body = page.locator(editor)
  await expect(body.locator('.bn-block-outer')).toHaveCount(2)
  const last = (await body.locator('.bn-block-outer').last().boundingBox())!
  const scroll = (await page.getByTestId('page-scroll').boundingBox())!
  // Off to the side of the text column, well below the last line.
  await page.mouse.click(scroll.x + 20, last.y + last.height + 120)
  await expect(body.locator('.bn-block-outer')).toHaveCount(3)
  await page.keyboard.type('third')
  await waitForFile(file, '- [ ] second\n\nthird\n')

  // A second click reuses the empty line it leaves rather than stacking more.
  await page.keyboard.press('Enter')
  await page.mouse.click(scroll.x + scroll.width / 2, scroll.y + scroll.height - 40)
  await page.keyboard.type('fourth')
  await waitForFile(file, 'third\n\nfourth\n')
  await expect(body.locator('.bn-block-outer')).toHaveCount(4)
})

test('dragging the scrollbar below the last block only scrolls, even with floating scrollbars on', async ({
  tmp
}) => {
  const userData = await tmp('user')
  const workspace = await tmp('workspace')
  await writeFile(join(userData, 'settings.json'), JSON.stringify({ lastWorkspace: workspace }))
  const lines = Array.from({ length: 60 }, (_, i) => `Line ${i}`)
  const long = join(workspace, 'Long.md')
  await writeFile(long, lines.join('\n\n') + '\n')
  const past = new Date(Date.now() - 60_000)
  await utimes(long, past, past)
  // macOS's trackpad default, where native scrollbars would float over the content.
  const app = await launchElectron({
    args: ['out/main/index.js', '-AppleShowScrollBars', 'WhenScrolling'],
    env: { NOBSIDIAN_USER_DATA: userData, NODE_ENV: 'test', NOBSIDIAN_MCP_PORT: '0' }
  })
  const page = await app.firstWindow()
  await page.getByTestId('sidebar-row-Long').click()
  const scroll = page.getByTestId('page-scroll')
  await expect(scroll.locator(editor)).toBeVisible()
  await expect
    .poll(() => scroll.evaluate((el: HTMLElement) => el.offsetWidth - el.clientWidth))
    .toBe(12)
  await scroll.evaluate((el) => (el.scrollTop = el.scrollHeight))
  const box = (await scroll.boundingBox())!
  await page.mouse.move(box.x + box.width - 4, box.y + box.height - 30)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width - 4, box.y + box.height / 2, { steps: 5 })
  await page.mouse.up()
  await expect(scroll.locator('.bn-block-outer')).toHaveCount(60)
  expect(await page.evaluate(() => !!document.activeElement?.closest('.bn-editor'))).toBe(false)
  await app.close()
})
