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
    await mkdir(dirname(this.file), { recursive: true })
    await writeFileAtomic(this.file, JSON.stringify(this.current, null, 2) + '\n')
    return this.current
  }
}
