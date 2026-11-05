import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // Playwright's default of half the cores leaves CI's 3-core macOS runners at one worker.
  workers: process.env.CI ? 3 : undefined,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: { trace: 'retain-on-failure' },
  projects: [
    { name: 'app', grepInvert: /@clipboard/ },
    // The macOS clipboard is shared by every running app, so these take turns.
    { name: 'clipboard', grep: /@clipboard/, workers: 1 }
  ]
})
