import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/** On the first launch as Nobi, takes over the app data saved under the old name, Nobsidian. */
export function migrateUserData(appData: string, userData: string): void {
  const legacy = join(appData, 'Nobsidian')
  if (existsSync(join(userData, 'settings.json')) || !existsSync(legacy)) return
  mkdirSync(userData, { recursive: true })
  // Entry by entry: Electron may already have started files of its own in the new folder.
  for (const name of readdirSync(legacy)) {
    if (!existsSync(join(userData, name))) renameSync(join(legacy, name), join(userData, name))
  }
  if (readdirSync(legacy).length === 0) rmSync(legacy, { recursive: true })
  // Encrypted with the old app's Keychain entry, which Nobi can't read.
  rmSync(join(userData, 'anthropic-key.json'), { force: true })
}
