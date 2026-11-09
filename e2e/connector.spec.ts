import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { clickInEditor, menu, editor, newPage, pressInEditor, waitForFile } from './helpers'

// The menu command is ignored until the workspace has loaded, which the sidebar shows.
async function openConnections(page: Page, app: ElectronApplication): Promise<Locator> {
  await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible()
  await menu(app, 'Settings…')
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await dialog.getByRole('button', { name: 'Connections' }).click()
  await expect(dialog.getByRole('heading', { name: 'Connections' })).toBeVisible()
  return dialog
}

async function shownCommand(dialog: Locator): Promise<{ url: string; token: string }> {
  const command = dialog.locator('.settings-command-text')
  await expect(command).toHaveText(
    /^claude mcp add --scope user --transport http nobi http:\/\/127\.0\.0\.1:\d+\/mcp --header "Authorization: Bearer [0-9a-f]{64}"$/
  )
  const [, url, token] = /(http\S+) --header "Authorization: Bearer (\w+)"/.exec(
    (await command.textContent())!
  )!
  return { url, token }
}

async function connect({ url, token }: { url: string; token: string }): Promise<Client> {
  const client = new Client({ name: 'e2e', version: '0.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } }
    })
  )
  return client
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<string> {
  const result = await client.callTool({ name, arguments: args })
  const text = (result.content as { text: string }[]).map((c) => c.text).join('')
  if (result.isError) throw new Error(text)
  return text
}

const idOf = (outline: string, title: string): string =>
  new RegExp(`- ${title} \\(id: ([0-9a-f-]{36})\\)`).exec(outline)![1]

test('Claude Code connects from Settings, and the open page shows what it writes', async ({
  nb
}) => {
  const { page, app, workspace } = nb
  await newPage(page, 'Plans')
  await page.keyboard.type('Draft')
  const file = join(workspace, 'Plans.md')
  await waitForFile(file, 'Draft')

  const dialog = await openConnections(page, app)
  await expect(dialog.locator('.settings-command')).toHaveCount(0)
  await dialog.getByRole('switch', { name: 'Let Claude Code use your notes' }).click()
  const client = await connect(await shownCommand(dialog))
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  const plans = idOf(await call(client, 'list_pages'), 'Plans')
  const read = await call(client, 'read_page', { id: plans })
  expect(read).toContain('\nDraft\n')
  const version = /^version: (\w+)$/m.exec(read)![1]
  await call(client, 'update_page', { id: plans, markdown: 'Rewritten by Claude', version })
  await expect(page.locator(editor)).toHaveText('Rewritten by Claude')
  await expect(page.getByRole('status')).toHaveCount(0)

  await call(client, 'create_page', { title: 'Launch', parentId: plans, markdown: 'Go live.' })
  await expect(page.locator(editor)).toContainText('Launch')
  const row = page.getByTestId('sidebar-row-Plans')
  await row.hover()
  await row.getByRole('button', { name: 'Expand' }).click()
  await expect(page.getByTestId('sidebar-row-Launch')).toBeVisible()
  await waitForFile(join(workspace, 'Plans', 'Launch.md'), 'Go live.')
  const launch = idOf(await call(client, 'list_pages'), 'Launch')
  expect(await call(client, 'read_page', { id: plans })).toContain(
    `[Launch](nobi://page/${launch} "page")`
  )

  // Typing Claude's write lands on is kept on screen, not overwritten either way.
  await clickInEditor(page, 'Rewritten by Claude')
  await pressInEditor(page, 'End')
  await page.keyboard.type(' and mine')
  await call(client, 'append_to_page', { id: plans, markdown: 'From Claude' })
  await expect(page.getByRole('status')).toContainText('This page was changed outside Nobi.')
  await expect(page.locator(editor)).toContainText('Rewritten by Claude and mine')
  await waitForFile(file, 'From Claude')
  await client.close()
})

test('the connection survives a relaunch, and resetting the token or turning it off cuts it', async ({
  nb
}) => {
  let dialog = await openConnections(nb.page, nb.app)
  await dialog.getByRole('switch', { name: 'Let Claude Code use your notes' }).click()
  const first = await shownCommand(dialog)
  await expect
    .poll(async () => JSON.parse(await readFile(join(nb.userData, 'settings.json'), 'utf8')).mcp)
    .toEqual({ enabled: true, port: Number(new URL(first.url).port) })

  const page = await nb.relaunch()
  dialog = await openConnections(page, nb.app)
  await expect(dialog.getByRole('switch', { name: 'Let Claude Code use your notes' })).toBeChecked()
  expect(await shownCommand(dialog)).toEqual(first)
  await (await connect(first)).close()

  await dialog.getByRole('button', { name: 'Reset' }).click()
  await expect(dialog.locator('.settings-command-text')).not.toContainText(first.token)
  const second = await shownCommand(dialog)
  expect(second.url).toBe(first.url)
  await expect(connect(first)).rejects.toThrow()
  await (await connect(second)).close()

  await dialog.getByRole('switch', { name: 'Let Claude Code use your notes' }).click()
  await expect(dialog.locator('.settings-command')).toHaveCount(0)
  await expect(connect(second)).rejects.toThrow()
})

test('Copy puts the command on the clipboard', { tag: '@clipboard' }, async ({ nb }) => {
  const dialog = await openConnections(nb.page, nb.app)
  await dialog.getByRole('switch', { name: 'Let Claude Code use your notes' }).click()
  const { url, token } = await shownCommand(dialog)
  await dialog.getByRole('button', { name: 'Copy' }).click()
  await expect(dialog.getByRole('button', { name: 'Copied' })).toBeVisible()
  expect(await nb.app.evaluate(({ clipboard }) => clipboard.readText())).toBe(
    `claude mcp add --scope user --transport http nobi ${url} --header "Authorization: Bearer ${token}"`
  )
})
