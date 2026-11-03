import { test as base, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeAnthropic } from './fakeAnthropic'
import { launchElectron } from './launch'

export interface AppFixture {
  app: ElectronApplication
  page: Page
  workspace: string
  userData: string
  relaunch: () => Promise<Page>
}

export async function launch(
  userData: string,
  aiUrl?: string
): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launchElectron({
    args: ['out/main/index.js'],
    env: {
      NOBSIDIAN_USER_DATA: userData,
      NODE_ENV: 'test',
      // Parallel test apps would otherwise share the connector's default port.
      NOBSIDIAN_MCP_PORT: '0',
      ...(aiUrl ? { NOBSIDIAN_AI_BASE_URL: aiUrl } : {})
    }
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

/** Makes a fresh folder for this test; all of them are removed once the test ends. */
type TempDir = (name: string) => Promise<string>

/** A running app with a fresh, empty workspace already open, talking to a fake Anthropic. */
export const test = base.extend<{ tmp: TempDir; nb: AppFixture; anthropic: FakeAnthropic }>({
  tmp: async ({}, use) => {
    const root = await mkdtemp(join(tmpdir(), 'nobsidian-e2e-'))
    await use(async (name) => {
      const dir = join(root, name)
      await mkdir(dir)
      return dir
    })
    await rm(root, { recursive: true, force: true })
  },
  anthropic: async ({}, use) => {
    const fake = await FakeAnthropic.start()
    await use(fake)
    await fake.close()
  },
  nb: async ({ anthropic, tmp }, use) => {
    const userData = await tmp('user')
    const workspace = await tmp('workspace')
    await writeFile(join(userData, 'settings.json'), JSON.stringify({ lastWorkspace: workspace }))
    let { app, page } = await launch(userData, anthropic.url)
    const fixture: AppFixture = {
      get app() {
        return app
      },
      get page() {
        return page
      },
      workspace,
      userData,
      relaunch: async () => {
        await app.close()
        ;({ app, page } = await launch(userData, anthropic.url))
        return page
      }
    }
    await use(fixture)
    await app.close()
  }
})

export { expect } from '@playwright/test'
