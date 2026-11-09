import { afterEach, beforeEach, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateUserData } from './userData'

let appData: string
const legacy = (): string => join(appData, 'Nobsidian')
const current = (): string => join(appData, 'Nobi')

beforeEach(async () => {
  appData = await mkdtemp(join(tmpdir(), 'nobi-user-data-'))
  await mkdir(legacy())
  await writeFile(join(legacy(), 'settings.json'), '{"theme":"dark"}')
  await writeFile(join(legacy(), 'anthropic-key.json'), '{}')
})
afterEach(async () => {
  await rm(appData, { recursive: true, force: true })
})

it('moves Nobsidian app data across, dropping the key only the old app could decrypt', async () => {
  await mkdir(current())
  await writeFile(join(current(), 'Local State'), 'electron')
  migrateUserData(appData, current())
  expect(await readFile(join(current(), 'settings.json'), 'utf8')).toBe('{"theme":"dark"}')
  expect((await readdir(current())).sort()).toEqual(['Local State', 'settings.json'])
  expect(existsSync(legacy())).toBe(false)
})

it('leaves both folders alone once Nobi has settings of its own', async () => {
  await mkdir(current())
  await writeFile(join(current(), 'settings.json'), '{"theme":"light"}')
  migrateUserData(appData, current())
  expect(await readFile(join(current(), 'settings.json'), 'utf8')).toBe('{"theme":"light"}')
  expect(await readdir(legacy())).toContain('settings.json')
})
