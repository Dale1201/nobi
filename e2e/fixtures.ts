import { test as base, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { FakeAnthropic, GOOD_KEY } from './fakeAnthropic'
import { launchElectron, running } from './launch'

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
      NOBI_USER_DATA: userData,
      NODE_ENV: 'test',
      // Parallel test apps would otherwise share the connector's default port.
      NOBI_MCP_PORT: '0',
      ...(aiUrl ? { NOBI_AI_BASE_URL: aiUrl } : {})
    }
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

/** Makes a fresh folder for this test; all of them are removed once the test ends. */
type TempDir = (name: string) => Promise<string>

export interface Seed {
  /** Workspace files by relative path, there before the app first scans the folder. */
  files?: Record<string, string | Buffer>
  /** Saves the fake Anthropic's good key, as Settings would. */
  aiKey?: boolean
}

/** Writes files with an old mtime, since the app holds back a file changed under a second ago. */
async function seed(
  workspace: string,
  userData: string,
  { files = {}, aiKey }: Seed
): Promise<void> {
  const past = new Date(Date.now() - 60_000)
  for (const [rel, body] of Object.entries(files)) {
    const path = join(workspace, rel)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, body)
    await utimes(path, past, past)
  }
  if (aiKey) {
    const encrypted = Buffer.from(`e2e:${GOOD_KEY}`).toString('base64')
    await writeFile(
      join(userData, 'anthropic-key.json'),
      JSON.stringify({ hint: `sk-ant-…${GOOD_KEY.slice(-4)}`, encrypted })
    )
  }
}

interface Fixtures {
  closeApps: void
  tmp: TempDir
  anthropic: FakeAnthropic
  /** Starts the app on a fresh workspace holding the seeded files. Use it instead of `nb`, not with it. */
  nbWith: (seed: Seed) => Promise<AppFixture>
  /** A running app with a fresh, empty workspace already open, talking to a fake Anthropic. */
  nb: AppFixture
}

export const test = base.extend<Fixtures>({
  // Depends on the folders so it tears down first, while they still exist.
  closeApps: [
    async ({ tmp }, use) => {
      void tmp
      await use()
      await Promise.all([...running].map((app) => app.close()))
    },
    { auto: true }
  ],
  tmp: async ({}, use) => {
    const root = await mkdtemp(join(tmpdir(), 'nobi-e2e-'))
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
  nbWith: async ({ anthropic, tmp }, use) => {
    let launched = 0
    const apps: AppFixture[] = []
    await use(async (options) => {
      const suffix = launched++ || ''
      const userData = await tmp(`user${suffix}`)
      const workspace = await tmp(`workspace${suffix}`)
      await writeFile(join(userData, 'settings.json'), JSON.stringify({ lastWorkspace: workspace }))
      await seed(workspace, userData, options)
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
      apps.push(fixture)
      return fixture
    })
    // Before the fake API it talks to goes away.
    await Promise.all(apps.map(({ app }) => app.close()))
  },
  nb: async ({ nbWith }, use) => {
    await use(await nbWith({}))
  }
})

export { expect } from '@playwright/test'
