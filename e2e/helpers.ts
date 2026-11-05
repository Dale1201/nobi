import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import type { IpcProbe } from '../src/main/ipc'
import { SAVE_DELAY_MS } from '../src/shared/editor'
import { expect, type AppFixture, type Seed } from './fixtures'

export const editor = '.bn-editor'

/** Waits until the freshly created page is showing, so typing can't land in the previous one. */
export async function typeNewPageTitle(page: Page, title: string): Promise<void> {
  const heading = page.getByTestId('page-title')
  await expect(heading).toHaveText('')
  await expect(heading).toBeFocused()
  await page.keyboard.type(title)
}

export async function waitForFile(path: string, match: RegExp | string): Promise<string> {
  let text = ''
  await expect
    .poll(async () => {
      text = await readFile(path, 'utf8').catch(() => '')
      return typeof match === 'string' ? text.includes(match) : match.test(text)
    })
    .toBe(true)
  return text
}

/** Creates a top-level page with a title and leaves the cursor in its body. */
export async function newPage(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: 'New page' }).first().click()
  await typeNewPageTitle(page, title)
  await expect(page.getByTestId(`sidebar-row-${title}`)).toBeVisible()
  await page.keyboard.press('Enter')
}

export async function rowAction(page: Page, title: string, action: string): Promise<void> {
  const row = page.getByTestId(`sidebar-row-${title}`)
  await row.hover()
  await row.getByRole('button', { name: 'Page actions' }).click()
  await page.getByRole('menuitem', { name: action, exact: true }).click()
}

/** Starts the app on a workspace holding one page and opens it. */
export async function openFile(
  nbWith: (seed: Seed) => Promise<AppFixture>,
  name: string,
  body: string,
  seed: Seed = {}
): Promise<AppFixture> {
  const nb = await nbWith({ ...seed, files: { ...seed.files, [`${name}.md`]: body } })
  await nb.page.getByTestId(`sidebar-row-${name}`).click()
  await expect(nb.page.locator(editor)).toBeVisible()
  return nb
}

/** Clicks an application menu item by label, hidden ones included, as its accelerator would. */
export async function menu(app: ElectronApplication, label: string): Promise<void> {
  const found = await app.evaluate(({ Menu }, label) => {
    const walk = (items: Electron.MenuItem[]): Electron.MenuItem | undefined => {
      for (const item of items) {
        if (item.label === label) return item
        const inner = item.submenu && walk(item.submenu.items)
        if (inner) return inner
      }
      return undefined
    }
    const item = walk(Menu.getApplicationMenu()?.items ?? [])
    item?.click()
    return Boolean(item)
  }, label)
  expect(found, `menu item ${label}`).toBe(true)
}

/** Every application menu item's accelerator, by label. */
export function accelerators(app: ElectronApplication): Promise<Record<string, string>> {
  return app.evaluate(({ Menu }) => {
    const out: Record<string, string> = {}
    const walk = (items: Electron.MenuItem[]): void => {
      for (const item of items) {
        if (item.accelerator) out[item.label] = item.accelerator
        if (item.submenu) walk(item.submenu.items)
      }
    }
    walk(Menu.getApplicationMenu()?.items ?? [])
    return out
  })
}

/** Makes the app's next native open dialog answer with these paths. */
export async function stubOpenDialog(app: ElectronApplication, filePaths: string[]): Promise<void> {
  await app.evaluate(({ dialog }, filePaths) => {
    dialog.showOpenDialog = (async () => ({
      canceled: false,
      filePaths
    })) as typeof dialog.showOpenDialog
  }, filePaths)
}

export const activePane = (page: Page): Locator => page.locator('.tab-pane.active')

/** The frontmatter of a page file, once the app has given the page its id. */
export async function frontmatter(file: string): Promise<string> {
  return /^---\n[\s\S]*?\n---\n/.exec(await waitForFile(file, /^---\n(?:.*\n)*?id: /))![0]
}

/** Opens the block menu of the first block matching `block`, a selector or a block's text. */
export async function openBlockMenu(
  page: Page,
  block: { selector: string } | string
): Promise<void> {
  const target =
    typeof block === 'string'
      ? page.locator(`${editor} .bn-block-content`, { hasText: block })
      : page.locator(block.selector)
  await target.first().hover()
  await page.getByRole('button', { name: 'Block menu' }).click()
  await expect(page.getByRole('menu')).toBeVisible()
}

/** How many times the renderer has invoked this IPC channel since launch. */
export function ipcCalls(app: ElectronApplication, channel: string): Promise<number> {
  return app.evaluate(
    (_electron, channel) => (globalThis as { nbIpc?: IpcProbe }).nbIpc!.calls[channel] ?? 0,
    channel
  )
}

/** Makes every call to this IPC channel fail, as a broken disk or keychain would. */
export async function failIpc(app: ElectronApplication, channel: string): Promise<void> {
  await app.evaluate((_electron, channel) => {
    ;(globalThis as { nbIpc?: IpcProbe }).nbIpc!.wrap[channel] = async () => {
      throw new Error(`${channel} failed for the test`)
    }
  }, channel)
}

export interface IpcTrace {
  /** Calls made since the trace began, and how many of them have answered. */
  counts(): Promise<{ started: number; finished: number }>
  /** Lets held calls run, in the order they were made. */
  release(): Promise<void>
}

/** Follows calls to one IPC channel; with `held`, they wait in order until released. */
export async function traceIpc(
  app: ElectronApplication,
  channel: string,
  { held = false } = {}
): Promise<IpcTrace> {
  await app.evaluate(
    (_electron, { channel, held }) => {
      type Trace = { started: number; finished: number; release: () => void }
      const g = globalThis as { nbIpc?: IpcProbe; nbTraces?: Record<string, Trace> }
      const trace: Trace = { started: 0, finished: 0, release: () => {} }
      let queue: Promise<unknown> = held
        ? new Promise<void>((r) => (trace.release = r))
        : Promise.resolve()
      g.nbTraces = { ...g.nbTraces, [channel]: trace }
      g.nbIpc!.wrap[channel] = (call) => {
        trace.started++
        const run = queue.then(call).finally(() => trace.finished++)
        queue = run.catch(() => undefined)
        return run
      }
    },
    { channel, held }
  )
  type Traces = {
    nbTraces: Record<string, { started: number; finished: number; release: () => void }>
  }
  return {
    counts: () =>
      app.evaluate((_electron, channel) => {
        const { started, finished } = (globalThis as unknown as Traces).nbTraces[channel]
        return { started, finished }
      }, channel),
    release: () =>
      app.evaluate((_electron, channel) => {
        ;(globalThis as unknown as Traces).nbTraces[channel].release()
      }, channel)
  }
}

/**
 * Resolves once every save the editors had queued has reached the main process: a timer set
 * now fires after the editors' save debounce, and IPC keeps its order. `workspace:current` is
 * the round trip that still answers when no folder is open.
 */
export async function afterPendingSaves(page: Page): Promise<void> {
  await page.evaluate(
    (delay) =>
      new Promise((resolve) => setTimeout(resolve, delay)).then(() =>
        window.api.invoke('workspace:current', undefined)
      ),
    SAVE_DELAY_MS
  )
}

export const AI_PAGE = 'Intro.\n\nWe spent the hour arguing about launch.\n\nOutro.\n'
/** The Writer's diff and kept selection; the editor itself carries nb-ai-available. */
export const AI_MARKS = '.nb-ai-added, .nb-ai-removed, .nb-ai-added-block, .nb-ai-removed-block'

/** Starts with the AI key saved and Notes open, its id written. */
export async function openAiPage(
  nbWith: (seed: Seed) => Promise<AppFixture>,
  body = AI_PAGE,
  { files, aiKey = true }: Seed = {}
): Promise<AppFixture> {
  const nb = await nbWith({
    files: { 'Other.md': 'Elsewhere.\n', ...files, 'Notes.md': body },
    aiKey
  })
  await nb.page.getByTestId('sidebar-row-Notes').click()
  await expect(nb.page.locator(editor)).toContainText('Outro.')
  await waitForFile(join(nb.workspace, 'Notes.md'), /^---\nid: /)
  return nb
}

/** A menu click reaches the window later, so this waits for the new tab before anything acts on it. */
export async function newTab(app: ElectronApplication, page: Page): Promise<void> {
  const tabs = page.locator('.tab')
  const count = await tabs.count()
  await menu(app, 'New Tab')
  await expect(tabs).toHaveCount(count + 1)
}

/**
 * ProseMirror reads a caret moved by a click or a key on the next `selectionchange`, so a key
 * pressed at once would act on the old caret. Waits until the editor's selection is the DOM's.
 */
async function settleCaret(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        type Editor = {
          state: { selection: { anchor: number; head: number } }
          view: { posAtDOM: (node: Node, offset: number) => number }
        }
        const editor = (document.activeElement?.closest('.ProseMirror') as { editor?: Editor })
          ?.editor
        const dom = getSelection()
        if (!editor || !dom?.anchorNode || !dom.focusNode) return false
        const { anchor, head } = editor.state.selection
        return (
          editor.view.posAtDOM(dom.anchorNode, dom.anchorOffset) === anchor &&
          editor.view.posAtDOM(dom.focusNode, dom.focusOffset) === head
        )
      })
    )
    .toBe(true)
}

export async function placeCaret(target: Locator, clickCount = 1): Promise<void> {
  // Focusing the editor makes ProseMirror put its caret back 20ms later, undoing a click or key
  // made sooner; waiting 20ms outlasts it, for a focus just before (a dialog closing) and this one.
  const focusSettled = (): Promise<unknown> =>
    target.page().evaluate(() => new Promise((r) => setTimeout(r, 20)))
  await focusSettled()
  await target.click({ clickCount })
  await focusSettled()
  await settleCaret(target.page())
}

export async function clickInEditor(page: Page, text: string, clickCount = 1): Promise<void> {
  await placeCaret(page.locator(editor).getByText(text), clickCount)
}

export async function pressInEditor(page: Page, key: string): Promise<void> {
  await page.keyboard.press(key)
  await settleCaret(page)
}

async function caretToLineEdge(page: Page, key: string, edge: 'start' | 'end'): Promise<void> {
  await expect(async () => {
    await pressInEditor(page, key)
    const atEdge = await page.evaluate((edge) => {
      type Editor = {
        state: {
          selection: {
            empty: boolean
            $head: { parentOffset: number; parent: { content: { size: number } } }
          }
        }
      }
      const editor = (document.activeElement?.closest('.ProseMirror') as { editor?: Editor })
        ?.editor
      const { empty, $head } = editor!.state.selection
      return empty && $head.parentOffset === (edge === 'start' ? 0 : $head.parent.content.size)
    }, edge)
    expect(atEdge).toBe(true)
  }).toPass({ timeout: 5000 })
}

/** Chromium now and then drops a Cmd+Right pressed just after a click, so it is pressed until it lands. */
export function caretToLineEnd(page: Page): Promise<void> {
  return caretToLineEdge(page, 'Meta+ArrowRight', 'end')
}

/**
 * Within 200ms of the editor gaining focus, ProseMirror takes a caret at the start of the document
 * for a browser reset and puts the old one back, so Home is pressed until it lands.
 */
export function caretToLineStart(page: Page): Promise<void> {
  return caretToLineEdge(page, 'Home', 'start')
}
