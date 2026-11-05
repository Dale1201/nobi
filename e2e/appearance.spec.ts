import { expect, test } from './fixtures'
import { editor, openFile } from './helpers'

test('a page that starts with a divider opens with nothing selected, and its long title ends with an ellipsis', async ({
  nbWith
}) => {
  const { page } = await openFile(
    nbWith,
    'A very long page title that will not fit in the breadcrumb bar',
    '---\n\nAfter the divider\n'
  )
  await expect(page.locator(editor)).toContainText('After the divider')
  const highlight = await page.evaluate(() => {
    const node = document.querySelector('.bn-editor .ProseMirror-selectednode')
    if (!node) return 'none'
    const target = node.querySelector(':scope > *') ?? node
    return getComputedStyle(target, '::after').boxShadow
  })
  expect(highlight, 'the divider is not highlighted').toBe('none')
  const title = page.locator('.breadcrumb .breadcrumb-title').last()
  await expect(title).toHaveCSS('text-overflow', 'ellipsis')
  await expect.poll(() => title.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
})
