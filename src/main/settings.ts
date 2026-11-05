import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { DEFAULT_AI_MODEL } from '../shared/ai'
import type { Settings } from '../shared/ipc'
import { writeFileAtomic } from './workspace/fs-utils'

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  sidebarWidth: 240,
  sidebarCollapsed: false,
  expanded: {},
  lastPage: {},
  tabs: {},
  recent: {},
  lastColor: { kind: 'background', color: 'yellow' },
  ai: { enabled: true, model: DEFAULT_AI_MODEL },
  mcp: { enabled: false }
}

export class SettingsStore {
  private current: Settings = { ...DEFAULT_SETTINGS }
  private saving: Promise<void> = Promise.resolve()

  constructor(private readonly file: string) {}

  async load(): Promise<Settings> {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as Partial<Settings>
      this.current = { ...DEFAULT_SETTINGS, ...raw }
    } catch {
      this.current = { ...DEFAULT_SETTINGS }
    }
    return this.current
  }

  get(): Settings {
    return this.current
  }

  async set(patch: Partial<Settings>): Promise<Settings> {
    this.current = { ...this.current, ...patch }
    // One write at a time, each of the latest settings: overlapping writes can land out of order.
    const write = this.saving.then(() => this.write())
    this.saving = write.catch(() => {})
    await write
    return this.current
  }

  private async write(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    await writeFileAtomic(this.file, JSON.stringify(this.current, null, 2) + '\n')
  }
}
