import { mkdir, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from './fs-utils'

export const APP_DIR = '.nobi'
const LEGACY_APP_DIR = '.nobsidian'
export const ROOT_ORDER_KEY = 'root'
export const STATE_FILE = 'workspace.json'

export interface WorkspaceState {
  version: 1
  /** Parent page id (or "root") -> ordered child page ids. */
  order: Record<string, string[]>
  favorites: string[]
}

const empty = (): WorkspaceState => ({ version: 1, order: {}, favorites: [] })

export async function loadState(root: string): Promise<WorkspaceState> {
  try {
    const raw = JSON.parse(await readFile(join(root, APP_DIR, STATE_FILE), 'utf8'))
    return {
      version: 1,
      order: typeof raw.order === 'object' && raw.order ? raw.order : {},
      favorites: Array.isArray(raw.favorites) ? raw.favorites : []
    }
  } catch {
    return empty()
  }
}

export function serializeState(state: WorkspaceState): string {
  return JSON.stringify(state, null, 2) + '\n'
}

export async function saveState(root: string, state: WorkspaceState): Promise<void> {
  await mkdir(join(root, APP_DIR), { recursive: true })
  await writeFileAtomic(join(root, APP_DIR, STATE_FILE), serializeState(state))
}

/** Renames the folder the app kept under its old name, Nobsidian, unless both exist. */
export async function migrateAppDir(root: string): Promise<void> {
  await rename(join(root, LEGACY_APP_DIR), join(root, APP_DIR)).catch(
    (err: NodeJS.ErrnoException) => {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(err.code ?? '')) throw err
    }
  )
}
