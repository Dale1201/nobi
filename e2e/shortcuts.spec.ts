import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { caretToLineEnd, clickInEditor, editor, newPage, openFile, waitForFile } from './helpers'

const lastType = (page: Page): Promise<string | null> =>
  page.locator(`${editor} .bn-block-content`).last().getAttribute('data-content-type')

const typed: [string, string, string][] = [
  ['- dash', 'bulletListItem', '- dash'],
  ['* star', 'bulletListItem', '- star'],
  ['+ plus', 'bulletListItem', '- plus'],
  ['1. number', 'numberedListItem', '1. number'],
  ['[] todo', 'checkListItem', '- [ ] todo'],
  ['" quote', 'quote', '> quote'],
  ['# one', 'heading', '# one'],
  ['## two', 'heading', '## two'],
  ['### three', 'heading', '### three'],
  // Notion has three heading levels.
  ['#### four', 'paragraph', '#### four'],
  ['> toggle', 'toggleListItem', '<summary>toggle</summary>']
]

test('Markdown shortcuts at the start of a line make Notion blocks, while > in a file stays a quote', async ({
  nbWith
}) => {
  const { page, workspace } = await openFile(nbWith, 'Typing', '> Quoted text\n')
  await expect(page.locator(`${editor} [data-content-type="quote"]`)).toHaveCount(1)
  await clickInEditor(page, 'Quoted text')
  await caretToLineEnd(page)
  for (const [keys, type] of typed) {
    await page.keyboard.press('Enter')
    await page.keyboard.press('Meta+Alt+0')
    await expect.poll(() => lastType(page), `a fresh line before "${keys}"`).toBe('paragraph')
    await page.keyboard.type(keys)
    await expect.poll(() => lastType(page), `typing "${keys}"`).toBe(type)
  }
  const file = await waitForFile(join(workspace, 'Typing.md'), '<summary>toggle</summary>')
  expect(file).toContain('> Quoted text')
  for (const [keys, , saved] of typed) expect(file, `"${keys}" saved`).toContain(saved)
})

test('--- and ``` make blocks at once, and inline Markdown applies while plain tildes stay', async ({
  nb
}) => {
  const { page } = nb
  await newPage(page, 'Inline')
  const blocks = page.locator(`${editor} .bn-block-content`)
  await page.keyboard.type('---abc')
  await expect(blocks, 'typing carries on below a --- divider').toHaveText(['', 'abc'])
  await expect(blocks.first()).toHaveAttribute('data-content-type', 'divider')
  await page.keyboard.press('Enter')
  await page.keyboard.type('**bold** *it* `code` ~gone~ ')
  await page.keyboard.press('Enter')
  const tildes = 'takes ~5 to ~10 minutes, copy ~/a to ~/b, a ~ b ~ c'
  await page.keyboard.type(tildes)
  await expect(blocks.last()).toHaveText(tildes)
  await expect(page.locator(`${editor} s`)).toHaveText(['gone'])
  await page.keyboard.press('Enter')
  await page.keyboard.type('```')
  await expect.poll(() => lastType(page)).toBe('codeBlock')
  const file = await waitForFile(join(nb.workspace, 'Inline.md'), '```')
  expect(file).toContain('**bold** *it* `code` ~~gone~~')
  // Markdown escapes the tildes so they are not read back as strikethrough.
  expect(file).toContain(tildes.replaceAll('~', '\\~'))
})

test('Cmd+D duplicates the block and Cmd+/ opens the block menu with search focused', async ({
  nbWith
}) => {
  const { page, workspace } = await openFile(nbWith, 'Dup', 'Copy me\n')
  await clickInEditor(page, 'Copy me')
  await page.keyboard.press('Meta+d')
  await expect(page.locator(`${editor} .bn-block-content`, { hasText: 'Copy me' })).toHaveCount(2)
  await page.keyboard.press('Meta+/')
  await expect(page.getByPlaceholder('Search actions…')).toBeFocused()
  await page.keyboard.type('heading 2')
  await page.keyboard.press('Enter')
  await waitForFile(join(workspace, 'Dup.md'), '## Copy me')
})

const turnKeys: [string, string][] = [
  ['4', 'checkListItem'],
  ['5', 'bulletListItem'],
  ['6', 'numberedListItem'],
  ['7', 'toggleListItem'],
  ['8', 'codeBlock'],
  ['1', 'heading'],
  ['0', 'paragraph']
]

test('Cmd+Option+number turns the block into Notion types', async ({ nbWith }) => {
  const { page } = await openFile(nbWith, 'Turns', 'Shape shifter\n')
  for (const [key, type] of turnKeys) {
    await clickInEditor(page, 'Shape shifter')
    await page.keyboard.press(`Meta+Alt+${key}`)
    await expect(
      page.locator(`${editor} .bn-block-content`).first(),
      `Cmd+Option+${key}`
    ).toHaveAttribute('data-content-type', type)
  }
})

test('Cmd+Enter ticks a to-do, acts on a selected block rather than the hidden caret, and opens a toggle', async ({
  nbWith
}) => {
  const { page, workspace } = await openFile(
    nbWith,
    'Enter',
    '- [ ] one\n- [ ] two\n\n<details>\n<summary>fold</summary>\n\ninside\n\n</details>\n'
  )
  const file = join(workspace, 'Enter.md')
  await clickInEditor(page, 'one')
  await page.keyboard.press('Meta+Enter')
  await waitForFile(file, '- [x] one\n- [ ] two')
  await page.keyboard.press('Escape')
  await page.keyboard.press('ArrowDown')
  await expect(page.locator(`${editor} .nb-block-selected`)).toHaveText(['two'])
  await page.keyboard.press('Meta+Enter')
  await waitForFile(file, '- [x] one\n- [x] two')
  await clickInEditor(page, 'fold')
  await page.keyboard.press('Meta+Enter')
  await expect(page.locator(`${editor} .bn-toggle-button`)).toHaveAttribute('aria-expanded', 'true')
})

test('Cmd+Shift+arrows move the block; Esc selects it and arrows, Shift and Backspace act on the selection', async ({
  nbWith
}) => {
  const { page } = await openFile(nbWith, 'Select', 'One\n\nTwo\n\nThree\n')
  const blocks = page.locator(`${editor} .bn-block-content`)
  const selected = page.locator(`${editor} .nb-block-selected`)
  await clickInEditor(page, 'Two')
  await page.keyboard.press('Meta+Shift+ArrowUp')
  await expect(blocks).toHaveText(['Two', 'One', 'Three'])
  await page.keyboard.press('Escape')
  await expect(selected).toHaveText(['Two'])
  await page.keyboard.press('ArrowDown')
  await expect(selected).toHaveText(['One'])
  await page.keyboard.press('Shift+ArrowDown')
  await expect(selected).toHaveText(['One', 'Three'])
  await page.keyboard.press('Meta+Shift+ArrowUp')
  await expect(blocks).toHaveText(['One', 'Three', 'Two'])
  await expect(selected, 'moved blocks stay selected').toHaveText(['One', 'Three'])
  await page.keyboard.type('xyz')
  await expect(page.locator(editor)).not.toContainText('xyz')
  await page.keyboard.press('Backspace')
  await expect(blocks).toHaveText(['Two'])
})

test(
  'a click or Enter returns to typing; copy takes the selected blocks',
  { tag: '@clipboard' },
  async ({ nbWith }) => {
    const { page, app } = await openFile(nbWith, 'Back', 'Alpha\n\nBeta\n')
    await clickInEditor(page, 'Alpha')
    await page.keyboard.press('Escape')
    await expect(page.locator(`${editor} .nb-block-selected`)).toHaveText(['Alpha'])
    await page.keyboard.press('Meta+c')
    await expect
      .poll(() => app.evaluate(({ clipboard }) => clipboard.readText()))
      .toContain('Alpha')
    await page.keyboard.press('Enter')
    await expect(page.locator(`${editor} .nb-block-selected`)).toHaveCount(0)
    await page.keyboard.type('!')
    await expect(page.locator(`${editor} .bn-block-content`).first()).toHaveText('Alpha!')
    await page.keyboard.press('Escape')
    await expect(page.locator(`${editor} .nb-block-selected`)).toHaveCount(1)
    await page.locator(`${editor} .bn-inline-content`, { hasText: 'Beta' }).click()
    await expect(page.locator(`${editor} .nb-block-selected`)).toHaveCount(0)
  }
)

test('a selection holding a parent and its child deletes both, and nothing else', async ({
  nbWith
}) => {
  const { page } = await openFile(nbWith, 'Nested', '- parent\n  - child\n- after\n')
  await clickInEditor(page, 'parent')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Shift+ArrowDown')
  await expect(page.locator(`${editor} .nb-block-selected`).first()).toContainText('child')
  await page.keyboard.press('Backspace')
  await expect(page.locator(`${editor} .bn-block-content`)).toHaveText(['after'])
})

test('arrow keys skip blocks hidden in a closed toggle', async ({ nbWith }) => {
  const { page, workspace } = await openFile(
    nbWith,
    'Hidden',
    '<details>\n<summary>fold</summary>\n\nsecret\n\n</details>\n\nvisible\n'
  )
  await expect(page.locator(`${editor} .bn-toggle-button`)).toHaveAttribute(
    'aria-expanded',
    'false'
  )
  await clickInEditor(page, 'fold')
  await page.keyboard.press('Escape')
  await page.keyboard.press('ArrowDown')
  await expect(page.locator(`${editor} .nb-block-selected`)).toHaveText(['visible'])
  await page.keyboard.press('Backspace')
  const file = await waitForFile(join(workspace, 'Hidden.md'), /^(?![\s\S]*visible)/)
  expect(file).toContain('secret')
})

test('Enter leaves a selected page link selected, as it has no text to type in', async ({
  nbWith
}) => {
  const { page } = await openFile(nbWith, 'Links', 'One\n\n[Target](Target.md "page")\n', {
    files: { 'Target.md': 't\n' }
  })
  await clickInEditor(page, 'One')
  await page.keyboard.press('Escape')
  await page.keyboard.press('ArrowDown')
  const selected = page.locator(`${editor} .nb-block-selected`)
  await expect(selected).toHaveText([/Target/])
  await page.keyboard.press('Enter')
  await expect(selected).toHaveText([/Target/])
})
