import { chmod, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import {
  activePane,
  afterPendingSaves,
  caretToLineEnd,
  clickInEditor,
  editor,
  frontmatter,
  newPage,
  traceIpc,
  waitForFile
} from './helpers'

/** Sets the mode of the history folder and every page's folder in it. */
async function chmodHistory(workspace: string, mode: number): Promise<void> {
  const base = join(workspace, '.nobi', 'history')
  for (const name of await readdir(base)) await chmod(join(base, name), mode)
  await chmod(base, mode)
}

async function historyTexts(workspace: string, id: string): Promise<string[]> {
  const dir = join(workspace, '.nobi', 'history', id)
  const names = (await readdir(dir).catch(() => [])).filter((v) => v.endsWith('.md'))
  return Promise.all(names.map((v) => readFile(join(dir, v), 'utf8')))
}

/** A page with unsaved edits under the conflict banner; returns the page file and its id. */
async function conflicted(
  nb: { page: Page; workspace: string },
  title = 'Shared'
): Promise<[string, string]> {
  const { page, workspace } = nb
  await newPage(page, title)
  await page.keyboard.type('Base')
  const file = join(workspace, `${title}.md`)
  await waitForFile(file, 'Base')
  const head = await frontmatter(file)
  await page.keyboard.type(' plus mine')
  await writeFile(file, `${head}\nTheirs\n`)
  await expect(page.getByRole('status')).toContainText('This page was changed outside Nobi.')
  // The app's own text it replaced goes to history first; wait for it before breaking history.
  const id = /id: (\S+)/.exec(head)![1]
  await expect.poll(async () => (await historyTexts(workspace, id)).length).toBe(1)
  return [file, id]
}

test('an outside edit reloads the open page when nothing is unsaved', async ({ nb }) => {
  const { page, workspace } = nb
  await newPage(page, 'Shared')
  await page.keyboard.type('Original')
  const file = join(workspace, 'Shared.md')
  await waitForFile(file, 'Original')
  await writeFile(file, `${await frontmatter(file)}\nEdited in another app\n`)
  await expect(page.locator(editor)).toHaveText('Edited in another app')
  await expect(page.getByRole('status')).toHaveCount(0)
})

test('an outside edit during typing asks before replacing it, and keeps both', async ({ nb }) => {
  const { page, workspace } = nb
  const [file, id] = await conflicted(nb)
  const head = await frontmatter(file)
  const banner = page.getByRole('status')
  await expect(page.locator(editor)).toHaveText('Base plus mine')
  await banner.getByRole('button', { name: 'Keep mine' }).click()
  await expect(banner).toHaveCount(0)
  await waitForFile(file, 'Base plus mine')
  expect((await historyTexts(workspace, id)).some((t) => t.endsWith('\nTheirs\n'))).toBe(true)

  await page.keyboard.type(' again')
  await writeFile(file, `${head}\nTheirs again\n`)
  await banner.getByRole('button', { name: 'Reload' }).click()
  await expect(page.locator(editor)).toHaveText('Theirs again')
  await expect
    .poll(async () =>
      (await historyTexts(workspace, id)).some((t) => t.includes('Base plus mine again'))
    )
    .toBe(true)
  await afterPendingSaves(page)
  expect(await readFile(file, 'utf8'), 'no save of the replaced edits').toContain('Theirs again')
})

test('the banner stays until the user chooses, even after opening history', async ({ nb }) => {
  const { page } = nb
  const [file, id] = await conflicted(nb)
  const head = await frontmatter(file)
  const banner = page.getByRole('status')

  await page.getByRole('button', { name: 'Page menu' }).click()
  await page.getByRole('menuitem', { name: 'Page history' }).click()
  const dialog = page.getByRole('dialog', { name: 'Page history' })
  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect(dialog).toHaveCount(0)

  await page.evaluate((id) => {
    const w = window as { changed?: boolean }
    window.api.on('page:changed', (e) => {
      if (e.id === id) w.changed = true
    })
  }, id)
  const reads = await traceIpc(nb.app, 'page:read')
  await writeFile(file, `${head}\nTheirs again\n`)
  await expect.poll(() => page.evaluate(() => (window as { changed?: boolean }).changed)).toBe(true)
  // A reload would send its read as the change arrives; this round trip lands after it.
  await page.evaluate(() => window.api.invoke('tree:get', undefined))
  expect((await reads.counts()).started, 'the edited page was not read again').toBe(0)
  await expect(banner).toBeVisible()
  await expect(page.locator(editor)).toHaveText('Base plus mine')
})

test('a failed Keep mine keeps the banner until the save succeeds', async ({ nb }) => {
  const { page, workspace } = nb
  const [file] = await conflicted(nb)
  const banner = page.getByRole('status')
  try {
    await chmod(workspace, 0o555)
    await banner.getByRole('button', { name: 'Keep mine' }).click()
    await expect(page.getByRole('alert')).toContainText("Couldn't save")
    await expect(banner).toBeVisible()
  } finally {
    await chmod(workspace, 0o755)
  }
  await banner.getByRole('button', { name: 'Keep mine' }).click()
  await expect(banner).toHaveCount(0)
  await waitForFile(file, 'Base plus mine')
})

test('leaving a page during a conflict keeps the outside version and the edits in history', async ({
  nb
}) => {
  const { page, workspace } = nb
  await newPage(page, 'Other')
  const [file, id] = await conflicted(nb)
  await page.getByTestId('sidebar-row-Other').click()
  await expect
    .poll(async () => (await historyTexts(workspace, id)).some((t) => t.includes('Base plus mine')))
    .toBe(true)
  const text = await readFile(file, 'utf8')
  expect(text).toContain('Theirs')
  expect(text).not.toContain('plus mine')
})

test('Reload keeps the edits and the banner when they cannot be kept in history', async ({
  nb
}) => {
  const { page, workspace } = nb
  const [file, id] = await conflicted(nb)
  const banner = page.getByRole('status')
  try {
    await chmodHistory(workspace, 0o555)
    await banner.getByRole('button', { name: 'Reload' }).click()
    await expect(page.getByRole('alert')).toContainText("Couldn't save the page")
    await expect(banner).toBeVisible()
    await expect(page.locator(editor)).toHaveText('Base plus mine')
    expect(await readFile(file, 'utf8')).toContain('Theirs')
  } finally {
    await chmodHistory(workspace, 0o755)
  }
  await banner.getByRole('button', { name: 'Reload' }).click()
  await expect(page.locator(editor)).toHaveText('Theirs')
  await expect(banner).toHaveCount(0)
  expect((await historyTexts(workspace, id)).some((t) => t.includes('Base plus mine'))).toBe(true)
})

test('leaving a page whose edits cannot be kept brings it back with the edits', async ({ nb }) => {
  const { page, workspace } = nb
  // The page comes back with its edits in a new tab.
  const pane = activePane(page)
  await newPage(page, 'Other')
  const [file, id] = await conflicted(nb)
  const banner = pane.getByRole('status')
  try {
    await chmodHistory(workspace, 0o555)
    await page.getByTestId('sidebar-row-Other').click()
    await expect(page.getByRole('alert')).toContainText("Couldn't save the page")
    await expect(pane.getByTestId('page-title')).toHaveText('Shared')
    await expect(banner).toContainText('This page was changed outside Nobi.')
    await expect(pane.locator(editor)).toHaveText('Base plus mine')
  } finally {
    await chmodHistory(workspace, 0o755)
  }
  await page.getByTestId('sidebar-row-Other').click()
  await expect(pane.getByTestId('page-title')).toHaveText('Other')
  await expect
    .poll(async () => (await historyTexts(workspace, id)).some((t) => t.includes('Base plus mine')))
    .toBe(true)
  expect(await readFile(file, 'utf8')).toContain('Theirs')
})

test('a page that cannot be saved keeps its edits, comes back when left, and saves once it can', async ({
  nb
}) => {
  const { page, workspace } = nb
  // The page comes back with its edits in a new tab.
  const pane = activePane(page)
  await newPage(page, 'Other')
  await newPage(page, 'Locked')
  await page.keyboard.type('Start')
  const file = join(workspace, 'Locked.md')
  await waitForFile(file, 'Start')
  try {
    await chmod(workspace, 0o555)
    await page.keyboard.type(' more')
    await expect(page.getByRole('alert')).toContainText("Couldn't save")
    await page.getByTestId('sidebar-row-Other').click()
    await expect(page.getByRole('alert')).toContainText("Couldn't save the page")
    await expect(pane.getByTestId('page-title')).toHaveText('Locked')
    await expect(pane.locator(editor)).toHaveText('Start more')
    await expect(pane.getByRole('status')).toHaveCount(0)
  } finally {
    await chmod(workspace, 0o755)
  }
  await clickInEditor(page, 'Start more')
  await caretToLineEnd(page)
  await page.keyboard.type(' end')
  await waitForFile(file, 'Start more end')
  await page.getByTestId('sidebar-row-Other').click()
  await expect(pane.getByTestId('page-title')).toHaveText('Other')
})

test('a page deleted outside while its edits cannot be kept leaves a recovered page', async ({
  nb
}) => {
  const { page, workspace } = nb
  // The page comes back with its edits in a new tab.
  const pane = activePane(page)
  const [file] = await conflicted(nb)
  try {
    await chmodHistory(workspace, 0o555)
    await unlink(file)
    await expect(page.getByRole('alert')).toContainText("Couldn't save the page")
    await expect(pane.getByTestId('page-title')).toHaveText('Recovered edits')
    await expect(pane.locator(editor)).toHaveText('Base plus mine')
    await waitForFile(join(workspace, 'Recovered edits.md'), 'Base plus mine')
  } finally {
    await chmodHistory(workspace, 0o755)
  }
})

test('quitting holds when the edits cannot be kept, and asks first', async ({ nb }) => {
  const { app, page, workspace } = nb
  await conflicted(nb)
  try {
    await chmodHistory(workspace, 0o555)
    await app.evaluate(({ app, dialog }) => {
      const asked: string[] = []
      ;(globalThis as { asked?: string[] }).asked = asked
      dialog.showMessageBox = (async (_win: unknown, options: Electron.MessageBoxOptions) => {
        asked.push(options.message)
        return { response: 0, checkboxChecked: false }
      }) as typeof dialog.showMessageBox
      app.quit()
    })
    await expect(page.getByRole('alert')).toContainText("Couldn't save the page")
    await expect
      .poll(() => app.evaluate(() => (globalThis as { asked?: string[] }).asked))
      .toEqual(["Some edits couldn't be saved."])
    await expect(page.getByRole('status')).toBeVisible()
    await expect(page.locator(editor)).toHaveText('Base plus mine')
  } finally {
    await chmodHistory(workspace, 0o755)
  }
})

test('pages added, renamed and deleted in Finder show up in the sidebar', async ({ nb }) => {
  const { page, workspace } = nb
  await newPage(page, 'Anchor')
  await writeFile(join(workspace, 'From Finder.md'), 'Hello\n')
  await expect(page.getByTestId('sidebar-row-From Finder')).toBeVisible()
  await rename(join(workspace, 'From Finder.md'), join(workspace, 'Renamed in Finder.md'))
  await expect(page.getByTestId('sidebar-row-Renamed in Finder')).toBeVisible()
  await expect(page.getByTestId('sidebar-row-From Finder')).toHaveCount(0)
  await unlink(join(workspace, 'Renamed in Finder.md'))
  await expect(page.getByTestId('sidebar-row-Renamed in Finder')).toHaveCount(0)
})

test('a notes folder that disappears while open shows the locate screen', async ({ nb }) => {
  const { page, workspace } = nb
  await newPage(page, 'Anything')
  await page.keyboard.type('Some words')
  await waitForFile(join(workspace, 'Anything.md'), 'Some words')
  await page.keyboard.type(' and more')
  await rm(workspace, { recursive: true, force: true })
  await expect(page.getByRole('heading', { name: "Can't find your notes" })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Locate folder' })).toBeVisible()
  await afterPendingSaves(page)
  await expect(readdir(workspace)).rejects.toThrow()
})
