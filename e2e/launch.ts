import { _electron as electron, type ElectronApplication } from '@playwright/test'

type LaunchOptions = NonNullable<Parameters<typeof electron.launch>[0]>

/** Apps still open; the fixtures close them after each test, even one that failed midway. */
export const running = new Set<ElectronApplication>()

/** Every test launch goes through here, so the app runs hidden (NOBI_E2E_SHOW=1 shows it). */
export async function launchElectron(options: LaunchOptions): Promise<ElectronApplication> {
  const app = await electron.launch({
    ...options,
    // Pixel checks read colors in the display's profile; sRGB keeps them the same on every Mac.
    args: ['--force-color-profile=srgb', ...(options.args ?? [])],
    env: { ...process.env, ...options.env, NOBI_E2E: '1' }
  })
  running.add(app)
  app.on('close', () => running.delete(app))
  return app
}
