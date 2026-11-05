import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { GOOD_KEY } from './fakeAnthropic'
import type { ElectronApplication, Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { editor, failIpc, menu, newPage } from './helpers'

// The menu command is ignored until the workspace has loaded, which the sidebar shows.
async function openAiSettings(page: Page, app: ElectronApplication): Promise<void> {
  await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible()
  await menu(app, 'Settings…')
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog.getByRole('heading', { name: 'Preferences' })).toBeVisible()
  await dialog.getByRole('button', { name: 'AI', exact: true }).click()
  await expect(dialog.getByRole('heading', { name: 'AI', exact: true })).toBeVisible()
}

const settingsFile = async (userData: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(join(userData, 'settings.json'), 'utf8'))

test('Settings opens from the sidebar and the app menu, and changes the theme', async ({ nb }) => {
  const { page, app } = nb
  await page.getByRole('button', { name: 'Settings' }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog.getByRole('heading', { name: 'Preferences' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Theme' }).click()
  await page.getByRole('menuitem', { name: 'Dark' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect.poll(async () => (await settingsFile(nb.userData)).theme).toBe('dark')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  const accelerator = await app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()
      ?.items.flatMap((i) => i.submenu?.items ?? [])
      .find((i) => i.label === 'Settings…')
    return item?.accelerator
  })
  expect(accelerator).toBe('CmdOrCtrl+,')
  await menu(app, 'Settings…')
  await expect(dialog.getByRole('heading', { name: 'Preferences' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect(dialog).toBeHidden()
})

test('the AI section checks the key, picks the model and counts what was spent', async ({
  nb,
  anthropic
}) => {
  const { page, app } = nb
  await openAiSettings(page, app)
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog).toContainText('Images, files, drawings and other pages are never sent.')
  await expect(dialog).toContainText('$0.00')
  await expect(dialog).toContainText('0 requests')

  const field = dialog.getByLabel('Anthropic API key')
  await field.fill('sk-ant-wrong')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog.getByRole('alert')).toHaveText('Anthropic rejected this key.')
  await field.fill(GOOD_KEY)
  await field.press('Enter')
  await expect(dialog).toContainText('sk-ant-…a1b2')
  await expect(dialog).toContainText('✓ Key works')
  await expect(field).toBeHidden()

  await dialog.getByRole('button', { name: 'Model' }).click()
  await page.getByRole('menuitem', { name: 'Claude Sonnet 5.5' }).click()
  await expect(dialog.getByRole('button', { name: 'Model' })).toHaveText('Claude Sonnet 5.5')
  await expect
    .poll(async () => (await settingsFile(nb.userData)).ai)
    .toEqual({ enabled: true, model: 'claude-sonnet-5-5' })

  const toggle = dialog.getByRole('switch', { name: 'Show AI in the editor' })
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await expect
    .poll(async () => (await settingsFile(nb.userData)).ai)
    .toEqual({ enabled: false, model: 'claude-sonnet-5-5' })

  anthropic.reply({ text: 'Done.', usage: { input_tokens: 2300, output_tokens: 450 } })
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const off = window.api.on('ai:done', () => {
          off()
          resolve()
        })
        void window.api.invoke('ai:start', {
          sessionId: 's',
          requestId: 'r',
          title: 'Notes',
          markdown: 'x',
          selection: false,
          skill: 'continue'
        })
      })
  )
  expect(anthropic.messages()[0].model).toBe('claude-sonnet-5-5')
  await page.keyboard.press('Escape')
  await openAiSettings(page, app)
  await expect(dialog).toContainText('$0.01')
  await expect(dialog).toContainText('1 request')

  await dialog.getByRole('button', { name: 'Remove' }).click()
  await expect(dialog.getByLabel('Anthropic API key')).toBeVisible()
})

test('Settings takes the keyboard from the page, and gives focus back to a select', async ({
  nb
}) => {
  const { page, app } = nb
  await newPage(page, 'Draft')
  await page.keyboard.type('abc')
  await expect(page.locator(editor)).toContainText('abc')

  await openAiSettings(page, app)
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog).toBeVisible()
  await expect(dialog.locator(':focus')).toHaveCount(1)
  await page.keyboard.type('zzz')
  await expect(page.locator(editor)).not.toContainText('zzz')
  await page.keyboard.press('Tab')
  await expect(dialog.locator(':focus')).toHaveCount(1)

  const model = dialog.getByRole('button', { name: 'Model' })
  await model.click()
  await page.getByRole('menuitem', { name: 'Claude Haiku 5.5' }).click()
  await expect(model).toBeFocused()
})

test('the key field reports a failed save instead of sticking', async ({ nb }) => {
  const { page, app } = nb
  await openAiSettings(page, app)
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  const field = dialog.getByLabel('Anthropic API key')
  await expect(field).toBeVisible()

  await failIpc(app, 'ai:setKey')
  await field.fill(GOOD_KEY)
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(dialog.getByRole('alert')).toHaveText("Couldn't save the key.")
  await expect(dialog.getByRole('button', { name: 'Save' })).toBeEnabled()
})

test('a failed remove says so and keeps the key', async ({ nbWith }) => {
  const { page, app } = await nbWith({ aiKey: true })
  await openAiSettings(page, app)
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await expect(dialog).toContainText('sk-ant-…a1b2')

  await failIpc(app, 'ai:clearKey')
  await dialog.getByRole('button', { name: 'Remove' }).click()
  await expect(dialog.getByRole('alert')).toHaveText("Couldn't remove the key.")
  await expect(dialog).toContainText('sk-ant-…a1b2')
})
