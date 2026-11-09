import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import {
  AI_MARKS,
  activePane,
  afterPendingSaves,
  caretToLineEnd,
  clickInEditor,
  editor,
  ipcCalls,
  menu,
  newTab,
  openAiPage,
  pressInEditor,
  waitForFile
} from './helpers'

const blockText = (page: Page, index: number): Promise<string | null> =>
  page
    .locator('.bn-block-content')
    .nth(index)
    .evaluate((el) => el.textContent)

const columnsOf = (left: string, right: string): string =>
  `<div data-columns>\n\n<div data-column>\n\n${left}\n\n</div>\n\n<div data-column>\n\n${right}\n\n</div>\n\n</div>\n\n`

async function askAbout(page: Page, text: string): Promise<void> {
  await clickInEditor(page, text, 3)
  await page.keyboard.press('Meta+j')
}

// Each error's wording is unit-tested in src/main/ai; these check how the Writer handles one.
test('a failure says what went wrong, keeps what had arrived, and a skill can be retried', async ({
  nbWith,
  anthropic
}) => {
  const { page } = await openAiPage(nbWith)
  const writer = page.getByRole('dialog', { name: 'AI' })
  const run = async (skill: string): Promise<void> => {
    await askAbout(page, 'Outro.')
    await writer.getByRole('option', { name: skill }).click()
  }

  anthropic.reply({ status: 529 })
  await run('Improve writing')
  await expect(writer.getByRole('alert')).toHaveText(
    'Claude is busy right now. Try again in a moment.'
  )
  await expect(page.locator(AI_MARKS)).toHaveCount(0)
  await expect(page.locator(editor)).toContainText('Outro.')
  anthropic.reply({ text: 'Goodbye.' })
  await writer.getByRole('option', { name: 'Proofread' }).click()
  await expect(page.locator('.nb-ai-added')).toHaveText('Goodbye.')
  await expect(writer.getByRole('button', { name: 'Accept' })).toBeVisible()
  await writer.getByRole('button', { name: 'Undo' }).click()

  anthropic.reply({ text: 'Goodbye for now, everyone.', chunks: 3, drop: true })
  await run('Improve writing')
  await expect(writer.getByRole('alert')).toHaveText(
    "Can't reach Anthropic. Check your internet connection."
  )
  await expect(page.locator('.nb-ai-added')).toHaveText('Goodbye f')
  await expect(writer.getByRole('button', { name: 'Accept' })).toBeVisible()
  await writer.getByRole('button', { name: 'Undo' }).click()

  anthropic.reply({ status: 401 })
  await run('Proofread')
  await expect(writer.getByRole('alert')).toContainText('Your API key was rejected.')
  await writer.getByRole('button', { name: 'Open Settings' }).click()
  await expect(page.getByRole('dialog', { name: 'Settings' })).toContainText('Anthropic API key')
})

test('offline, AI is greyed out and Space types a space', async ({ nbWith }) => {
  const { page } = await openAiPage(nbWith)
  const writer = page.getByRole('dialog', { name: 'AI' })
  await page.context().setOffline(true)
  await page.evaluate(() => window.dispatchEvent(new Event('offline')))
  await clickInEditor(page, 'Intro.', 3)
  const button = page.getByRole('button', { name: 'Ask AI' })
  await expect(button).toBeDisabled()
  await page.keyboard.press('Meta+j')
  await expect(writer).toBeHidden()
  await button.hover()
  await expect(page.getByText('AI is unavailable offline')).toBeVisible()
  await pressInEditor(page, 'ArrowRight')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Space')
  await expect(writer).toBeHidden()
  await expect.poll(() => blockText(page, 1)).toBe(' ')

  await page.keyboard.press('Backspace')
  await page.keyboard.type('/ai')
  const item = page.getByRole('option', { name: /Ask AI/ })
  await expect(item).toHaveAttribute('aria-disabled', 'true')
  await expect(item).toHaveAttribute('title', 'AI is unavailable offline')
  await item.click({ force: true })
  await expect(item).toBeVisible()
  await expect(writer).toBeHidden()
  // Enter runs the highlighted Text item, which closes the menu, so it has to come last.
  await expect(page.getByRole('option', { name: 'Text' })).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Enter')
  await expect(item).toBeHidden()
  await expect(writer).toBeHidden()
  await expect.poll(() => blockText(page, 1)).toBe('')

  await page.context().setOffline(false)
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await page.keyboard.press('Space')
  await expect(writer).toBeVisible()
})

test('leaving the page while Claude writes removes the change', async ({ nbWith, anthropic }) => {
  const nb = await openAiPage(nbWith)
  const { page } = nb
  const before = await readFile(join(nb.workspace, 'Notes.md'), 'utf8')
  const saves = await ipcCalls(nb.app, 'page:write')
  anthropic.reply({ text: 'A rewrite in progress.', chunks: 4, hold: true })
  await askAbout(page, 'Outro.')
  await page
    .getByRole('dialog', { name: 'AI' })
    .getByRole('option', { name: 'Improve writing' })
    .click()
  await expect(page.locator('.nb-ai-added')).toBeVisible()

  await newTab(nb.app, page)
  await page.getByTestId('sidebar-row-Other').click()
  await page.getByTestId('tab-Notes').click()
  await expect(activePane(page).locator('.nb-ai-added')).toHaveCount(0)
  await expect(page.getByRole('dialog', { name: 'AI' })).toBeHidden()
  await expect(activePane(page).locator(editor)).toContainText('Outro.')
  await expect.poll(() => anthropic.streaming).toBe(0)
  anthropic.release()
  await expect(page.locator(AI_MARKS)).toHaveCount(0)
  await expect(activePane(page).locator(editor)).toContainText('Outro.')
  await expect(activePane(page).locator(editor)).not.toContainText('A rewrite')
  await afterPendingSaves(page)
  expect(await ipcCalls(nb.app, 'page:write')).toBe(saves)
  expect(await readFile(join(nb.workspace, 'Notes.md'), 'utf8')).toBe(before)
})

test('closing the tab while Claude writes removes the change', async ({ nbWith, anthropic }) => {
  const nb = await openAiPage(nbWith)
  const { page } = nb
  const before = await readFile(join(nb.workspace, 'Notes.md'), 'utf8')
  const saves = await ipcCalls(nb.app, 'page:write')
  await newTab(nb.app, page)
  await page.getByTestId('sidebar-row-Other').click()
  await page.getByTestId('tab-Notes').click()
  anthropic.reply({ text: 'A rewrite in progress.', chunks: 4, hold: true })
  await askAbout(page, 'Outro.')
  await page
    .getByRole('dialog', { name: 'AI' })
    .getByRole('option', { name: 'Improve writing' })
    .click()
  await expect(page.locator('.nb-ai-added')).toBeVisible()

  await menu(nb.app, 'Close Tab')
  await expect(page.getByTestId('tab-Notes')).toHaveCount(0)
  await expect(page.getByRole('dialog', { name: 'AI' })).toBeHidden()
  await expect.poll(() => anthropic.streaming).toBe(0)
  anthropic.release()
  await afterPendingSaves(page)
  expect(await ipcCalls(nb.app, 'page:write')).toBe(saves)
  expect(await readFile(join(nb.workspace, 'Notes.md'), 'utf8')).toBe(before)
  await page.getByTestId('sidebar-row-Notes').click()
  const pane = activePane(page).locator(editor)
  await expect(pane).toContainText('Outro.')
  await expect(pane).not.toContainText('A rewrite')
  await expect(page.locator(AI_MARKS)).toHaveCount(0)
})

test('nothing is marked before the first text arrives', async ({ nbWith, anthropic }) => {
  const { page } = await openAiPage(nbWith)
  const writer = page.getByRole('dialog', { name: 'AI' })
  anthropic.reply({ text: '', hold: true })
  await askAbout(page, 'Outro.')
  await writer.getByRole('option', { name: 'Improve writing' }).click()
  await expect(writer.getByRole('button', { name: 'Stop' })).toBeVisible()
  await expect.poll(() => anthropic.streaming).toBe(1)
  await expect(page.locator(AI_MARKS)).toHaveCount(0)
  await writer.getByRole('button', { name: 'Stop' }).click()
  await expect(writer.getByRole('button', { name: 'Stop' })).toBeHidden()
  await expect(page.locator(AI_MARKS)).toHaveCount(0)
  await expect(page.locator(editor)).toContainText('Outro.')

  anthropic.reply({ text: 'Goodbye.' })
  await writer.getByRole('option', { name: 'Proofread' }).click()
  await expect(page.locator('.nb-ai-removed')).toHaveText('Outro.')
  await expect(page.locator('.nb-ai-added')).toHaveText('Goodbye.')
})

test('quitting while Claude writes keeps the page as it was', async ({ nbWith, anthropic }) => {
  const nb = await openAiPage(nbWith)
  const { page } = nb
  const before = await readFile(join(nb.workspace, 'Notes.md'), 'utf8')
  await clickInEditor(page, 'Intro.')
  await caretToLineEnd(page)
  await page.keyboard.type(' Typed.')
  anthropic.reply({ text: 'A rewrite in progress.', chunks: 4, hold: true })
  await askAbout(page, 'Outro.')
  await page
    .getByRole('dialog', { name: 'AI' })
    .getByRole('option', { name: 'Improve writing' })
    .click()
  await expect(page.locator('.nb-ai-added')).toBeVisible()

  const again = await nb.relaunch()
  const saved = await readFile(join(nb.workspace, 'Notes.md'), 'utf8')
  expect(saved).toBe(before.replace('Intro.', 'Intro. Typed.'))
  await again.getByTestId('sidebar-row-Notes').click()
  await expect(again.locator(editor)).toContainText('Outro.')
  await expect(again.locator(editor)).not.toContainText('A rewrite')
})

test('with AI turned off in Settings, nothing in the editor offers it', async ({ nbWith }) => {
  const nb = await openAiPage(nbWith)
  const { page } = nb
  await menu(nb.app, 'Settings…')
  await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'AI' }).click()
  await page.getByRole('switch', { name: 'Show AI in the editor' }).click()
  await page.keyboard.press('Escape')

  await clickInEditor(page, 'Intro.', 3)
  await expect(page.getByRole('button', { name: 'Bold' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Ask AI' })).toHaveCount(0)
  await page.keyboard.press('Meta+j')
  await expect(page.getByRole('dialog', { name: 'AI' })).toBeHidden()
  await pressInEditor(page, 'ArrowRight')
  await page.keyboard.press('Enter')
  await expect(page.locator('[data-is-empty-and-focused]')).toHaveCSS(
    'content',
    /Press ‘\/’ for commands…/,
    { pseudo: 'after' }
  )
  await page.keyboard.press('Space')
  await expect(page.getByRole('dialog', { name: 'AI' })).toBeHidden()
  await expect.poll(() => blockText(page, 1)).toBe(' ')
  await page.keyboard.press('Backspace')
  await page.keyboard.type('/ai')
  await expect(page.getByRole('option', { name: /Ask AI/ })).toHaveCount(0)
})

test('the Writer and its diff look right in light and dark', async ({ nbWith, anthropic }) => {
  const nb = await openAiPage(nbWith)
  const { page } = nb
  await nb.app.evaluate(({ nativeTheme }) => {
    nativeTheme.themeSource = 'light'
  })
  anthropic.reply({ text: 'Goodbye.' })
  await askAbout(page, 'Outro.')
  const writer = page.getByRole('dialog', { name: 'AI' })
  await writer.getByRole('option', { name: 'Improve writing' }).click()
  await expect(writer.getByRole('button', { name: 'Accept' })).toBeVisible()
  await expect(writer).toHaveCSS('border-radius', '12px')
  await expect(writer).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  await expect(page.locator('.nb-ai-added')).toHaveCSS(
    'background-color',
    'rgba(35, 131, 226, 0.1)'
  )
  await expect(page.locator('.nb-ai-removed')).toHaveCSS('color', 'rgb(212, 76, 71)')
  await expect(page.locator('.nb-ai-removed')).toHaveCSS('text-decoration-line', 'line-through')
  await expect(writer.getByRole('button', { name: 'Accept' })).toHaveCSS(
    'background-color',
    'rgb(35, 131, 226)'
  )

  await menu(nb.app, 'Toggle Dark Mode')
  await expect(writer).toHaveCSS('background-color', 'rgb(32, 32, 32)')
  await expect(writer).toHaveCSS('box-shadow', /rgb\(56, 56, 54\) 0px 0px 0px 1px/)
  await expect(page.locator('.nb-ai-added')).toHaveCSS(
    'background-color',
    'rgba(35, 131, 226, 0.18)'
  )
  await expect(page.locator('.nb-ai-removed')).toHaveCSS('color', 'rgb(223, 84, 82)')
})

test('Cmd+J on a clicked image writes below it, and never into it', async ({
  nbWith,
  anthropic
}) => {
  const { page } = await openAiPage(nbWith, 'Intro.\n\n![](attachments/pic.svg)\n\nOutro.\n', {
    files: {
      'attachments/pic.svg':
        '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="teal"/></svg>'
    }
  })
  const writer = page.getByRole('dialog', { name: 'AI' })
  await page.locator(`${editor} img`).click()
  await page.keyboard.press('Meta+j')
  await expect(writer.getByRole('option').first()).toHaveText('Continue writing')

  anthropic.reply({ text: 'A teal box.' })
  await writer.getByRole('option', { name: 'Continue writing' }).click()
  await expect(page.locator('.nb-ai-added-block')).toHaveText('A teal box.')
  const sent = (anthropic.messages()[0].messages as { content: { text: string }[] }[])[0]
  expect(sent.content[0].text).toContain('Intro.\n\n[image]\n\n⟦cursor⟧\n\nOutro.')
  await writer.getByRole('button', { name: 'Accept' }).click()
  await expect(writer).toBeHidden()
  await expect(page.locator('.bn-block-content')).toHaveCount(4)
  await expect(page.locator('.bn-block-content').nth(1)).toHaveAttribute(
    'data-content-type',
    'image'
  )
  await expect.poll(() => blockText(page, 2)).toBe('A teal box.')
})

test('the Writer lines up with the page column when the page starts with columns', async ({
  nbWith
}) => {
  const toggle = '<details>\n<summary>Left.</summary>\n\nInside.\n\n</details>'
  const { page } = await openAiPage(nbWith, `${columnsOf(toggle, 'Right.')}Intro.\n\nOutro.\n`)
  const writer = page.getByRole('dialog', { name: 'AI' })
  await askAbout(page, 'Outro.')
  await expect(writer).toBeVisible()
  const outro = page.locator('.bn-block-content', { hasText: 'Outro.' })
  await expect
    .poll(async () => {
      const column = await outro.evaluate((el) => el.getBoundingClientRect().left)
      return Math.abs((await writer.boundingBox())!.x - column)
    })
    .toBeLessThan(1)
})

test('an answer the page cannot take ends with an error and keeps the change under review', async ({
  nbWith,
  anthropic
}) => {
  const nb = await openAiPage(nbWith, `${columnsOf('Left.', 'Right.')}Outro.\n`)
  const { page } = nb
  const writer = page.getByRole('dialog', { name: 'AI' })
  const box = writer.getByRole('textbox', { name: 'Ask AI' })
  // Columns cannot go inside a column.
  const unplaceable = { text: columnsOf('A', 'B') }

  anthropic.reply(unplaceable)
  await askAbout(page, 'Left.')
  await writer.getByRole('option', { name: 'Proofread' }).click()
  await expect(writer.getByRole('alert')).toHaveText('The answer could not be placed here.')
  await expect(writer.getByRole('button', { name: 'Stop' })).toBeHidden()
  await expect(page.locator(AI_MARKS)).toHaveCount(0)
  await expect(page.locator(editor)).toContainText('Left.')

  anthropic.reply({ text: 'Goodbye.\n\nFor now.' }, unplaceable)
  await writer.getByRole('option', { name: 'Improve writing' }).click()
  await expect(page.locator('.nb-ai-added-block')).toHaveText(['Goodbye.', 'For now.'])
  await expect(page.locator('.nb-ai-removed-block')).toHaveText(['Left.'])
  await box.fill('as columns')
  await box.press('Enter')
  await expect(writer.getByRole('alert')).toHaveText('The answer could not be placed here.')
  await expect(page.locator('.nb-ai-added-block')).toHaveText(['Goodbye.', 'For now.'])

  // What fitted while it streamed goes once the whole answer does not.
  // Its 101 characters in 10 chunks make the held first piece exactly "Left, then.".
  anthropic.reply({ text: `Left, then.\n\n${columnsOf('A', 'B')}`, chunks: 10, hold: true })
  await box.fill('then columns')
  await box.press('Enter')
  await expect(page.locator('.nb-ai-added')).toHaveText('Left, then.')
  anthropic.release()
  await expect(writer.getByRole('alert')).toHaveText('The answer could not be placed here.')
  await expect(page.locator('.nb-ai-added')).toHaveCount(0)
  await expect(page.locator('.nb-ai-added-block')).toHaveText(['Goodbye.', 'For now.'])
  await writer.getByRole('button', { name: 'Accept' }).click()
  await expect(writer).toBeHidden()
  await expect.poll(() => blockText(page, 0)).toBe('Goodbye.')
  await expect.poll(() => blockText(page, 2)).toBe('Right.')
  await waitForFile(join(nb.workspace, 'Notes.md'), 'For now.')
})

/** Whether Markdown the page cannot show as blocks, a raw block, has appeared in the editor. */
async function watchForRaw(page: Page): Promise<() => Promise<boolean>> {
  await page.evaluate((selector) => {
    const w = window as unknown as { rawSeen: boolean }
    w.rawSeen = false
    const root = document.querySelector(selector)!
    new MutationObserver(() => {
      if (root.querySelector('.nb-raw')) w.rawSeen = true
    }).observe(root, { subtree: true, childList: true, characterData: true })
  }, editor)
  return () => page.evaluate(() => (window as unknown as { rawSeen: boolean }).rawSeen)
}

test('a page with columns streams its translation as columns, and Accept saves them', async ({
  nbWith,
  anthropic
}) => {
  const nb = await openAiPage(nbWith, `${columnsOf('Left.', 'Right.')}Outro.\n`)
  const { page } = nb
  const writer = page.getByRole('dialog', { name: 'AI' })
  const box = writer.getByRole('textbox', { name: 'Ask AI' })
  const rawSeen = await watchForRaw(page)
  await clickInEditor(page, 'Outro.')
  await page.keyboard.press('Meta+j')
  await box.fill('Translate page')
  await writer.getByRole('option', { name: 'Translate page to…' }).click()
  await expect(box).toHaveValue('Translate page to ')
  anthropic.reply({ text: `${columnsOf('Gauche.', 'Droite.')}Fin.\n`, chunks: 12, delayMs: 60 })
  await box.pressSequentially('French')
  await box.press('Enter')

  await expect(writer.getByRole('button', { name: 'Accept' })).toBeVisible()
  await expect(writer.getByRole('alert')).toHaveCount(0)
  await expect(page.locator('.nb-ai-removed-block')).toHaveText(['Left.Right.', 'Outro.'])
  await expect(page.locator('.nb-ai-added-block')).toHaveText(['Gauche.Droite.', 'Fin.'])
  expect(await rawSeen()).toBe(false)
  await writer.getByRole('button', { name: 'Accept' }).click()
  await expect(writer).toBeHidden()
  const saved = await waitForFile(join(nb.workspace, 'Notes.md'), 'Fin.')
  expect(saved).toContain(`${columnsOf('Gauche.', 'Droite.')}Fin.\n`)
  expect(saved).not.toContain('Left.')
})

test('a follow-up streaming columns never shows them as raw Markdown', async ({
  nbWith,
  anthropic
}) => {
  const nb = await openAiPage(nbWith)
  const { page } = nb
  const writer = page.getByRole('dialog', { name: 'AI' })
  const box = writer.getByRole('textbox', { name: 'Ask AI' })
  anthropic.reply(
    { text: 'Goodbye.' },
    { text: columnsOf('Good.', 'Bye.'), chunks: 12, delayMs: 60 }
  )
  await askAbout(page, 'Outro.')
  await writer.getByRole('option', { name: 'Improve writing' }).click()
  await expect(page.locator('.nb-ai-added')).toHaveText('Goodbye.')
  const rawSeen = await watchForRaw(page)
  await box.fill('as columns')
  await box.press('Enter')

  await expect(writer.getByRole('button', { name: 'Accept' })).toBeVisible()
  await expect(writer.getByRole('alert')).toHaveCount(0)
  await expect(page.locator('.nb-ai-added-block')).toHaveText(['Good.Bye.'])
  expect(await rawSeen()).toBe(false)
  await writer.getByRole('button', { name: 'Accept' }).click()
  await expect(writer).toBeHidden()
  const saved = await waitForFile(join(nb.workspace, 'Notes.md'), 'Good.')
  expect(saved).toContain(columnsOf('Good.', 'Bye.').trim())
  expect(saved).not.toContain('Outro.')
})

test('a reply the page cannot take where it would go is not inserted', async ({
  nbWith,
  anthropic
}) => {
  const nb = await openAiPage(nbWith, `${columnsOf('Left.', 'Right.')}Outro.\n`)
  const { page } = nb
  const writer = page.getByRole('dialog', { name: 'AI' })
  anthropic.reply({ text: columnsOf('A', 'B') })
  await askAbout(page, 'Left.')
  await writer.getByRole('option', { name: 'Explain' }).click()
  await writer.getByRole('button', { name: 'Insert below' }).click()
  await expect(writer.getByRole('alert')).toHaveText('The answer could not be placed here.')
  await expect(page.locator(AI_MARKS)).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(writer).toBeHidden()
  await expect(page.locator(editor)).toHaveAttribute('contenteditable', 'true')
  await clickInEditor(page, 'Outro.')
  await pressInEditor(page, 'End')
  await page.keyboard.type(' Typed.')
  await waitForFile(join(nb.workspace, 'Notes.md'), 'Outro. Typed.')
})
