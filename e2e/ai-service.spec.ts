import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { GOOD_KEY } from './fakeAnthropic'
import { expect, test } from './fixtures'

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true })
  return entries.filter((e) => !e.isDirectory()).map((e) => join(e.parentPath, e.name))
}

// Chromium's storage may hold strings as UTF-16.
async function holdsKey(path: string): Promise<boolean> {
  const data = await readFile(path).catch(() => Buffer.alloc(0))
  return data.includes(GOOD_KEY) || data.includes(Buffer.from(GOOD_KEY, 'utf16le'))
}

/** Starts a request from the renderer and collects the events it gets back. */
async function run(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const requestId = crypto.randomUUID()
    const events: string[] = []
    const done = new Promise<void>((resolve) => {
      const offs = [
        window.api.on('ai:delta', (d) => {
          if (d.requestId === requestId) events.push(`${d.mode}:${d.text}`)
        }),
        window.api.on('ai:done', (d) => {
          if (d.requestId !== requestId) return
          events.push('done')
          offs.forEach((off) => off())
          resolve()
        }),
        window.api.on('ai:error', (d) => {
          if (d.requestId !== requestId) return
          events.push(`error:${d.kind}`)
          offs.forEach((off) => off())
          resolve()
        })
      ]
    })
    await window.api.invoke('ai:start', {
      sessionId: 's',
      requestId,
      title: 'Notes',
      markdown: '⟦selection⟧Long words.⟦/selection⟧',
      selection: true,
      skill: 'shorter'
    })
    await done
    return events
  })
}

test('the main process streams Claude to the renderer and keeps the key to itself', async ({
  nb,
  anthropic
}) => {
  const { page } = nb
  expect(await page.evaluate(() => window.api.invoke('ai:status', undefined))).toMatchObject({
    hasKey: false,
    month: { requests: 0 }
  })
  const saved = await page.evaluate((key) => window.api.invoke('ai:setKey', { key }), GOOD_KEY)
  expect(saved).toEqual({ ok: true })

  anthropic.reply({ text: 'Short.', chunks: 2 })
  expect(await run(page)).toEqual(['edit:Sho', 'edit:Short.', 'done'])

  const status = await page.evaluate(() => window.api.invoke('ai:status', undefined))
  expect(status).toMatchObject({ hasKey: true, keyHint: 'sk-ant-…a1b2', month: { requests: 1 } })
  expect(JSON.stringify(status)).not.toContain(GOOD_KEY)

  // Neither the settings, nor the notes folder, nor what the renderer can read hold the key.
  expect(await readFile(join(nb.userData, 'settings.json'), 'utf8')).not.toContain(GOOD_KEY)
  const stored = await filesUnder(nb.userData)
  expect(stored.some((path) => path.includes('Local Storage'))).toBe(true)
  for (const path of stored) {
    if (path === join(nb.userData, 'anthropic-key.json')) continue
    expect(await holdsKey(path), path).toBe(false)
  }
  for (const path of await filesUnder(nb.workspace)) {
    expect(await holdsKey(path), path).toBe(false)
  }
  const settings = await page.evaluate(() => window.api.invoke('settings:get', undefined))
  expect(JSON.stringify(settings)).not.toContain(GOOD_KEY)
  expect(settings.ai).toEqual({ enabled: true, model: 'claude-opus-5-5' })

  // The key survives a restart.
  const again = await nb.relaunch()
  expect(await again.evaluate(() => window.api.invoke('ai:status', undefined))).toMatchObject({
    hasKey: true
  })
})
