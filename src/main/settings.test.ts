import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, SettingsStore } from './settings'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nobi-settings-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

it('starts from defaults and persists patches', async () => {
  const file = join(dir, 'nested', 'settings.json')
  const store = new SettingsStore(file)
  expect(await store.load()).toEqual(DEFAULT_SETTINGS)
  await store.set({ theme: 'dark', lastWorkspace: '/tmp/notes' })
  const reloaded = new SettingsStore(file)
  expect(await reloaded.load()).toEqual({
    ...DEFAULT_SETTINGS,
    theme: 'dark',
    lastWorkspace: '/tmp/notes'
  })
  expect(JSON.parse(await readFile(file, 'utf8')).theme).toBe('dark')
})

it('falls back to defaults when the file is corrupt', async () => {
  const file = join(dir, 'settings.json')
  await writeFile(file, '{nope')
  expect(await new SettingsStore(file).load()).toEqual(DEFAULT_SETTINGS)
})
