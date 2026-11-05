import { link, open, rename, unlink, stat, readdir, rmdir } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const tmp = await writeTemp(path, data)
  try {
    await rename(tmp, path)
  } catch (err) {
    await unlink(tmp).catch(() => {})
    throw err
  }
}

/** Like `writeFileAtomic`, but leaves a file already at `path` alone and returns false. */
export async function createFileAtomic(path: string, data: string | Uint8Array): Promise<boolean> {
  const tmp = await writeTemp(path, data)
  try {
    await link(tmp, path)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw err
  } finally {
    await unlink(tmp).catch(() => {})
  }
}

async function writeTemp(path: string, data: string | Uint8Array): Promise<string> {
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`)
  const fh = await open(tmp, 'w')
  try {
    await fh.writeFile(data)
    await fh.sync()
  } finally {
    await fh.close()
  }
  return tmp
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * First of `stem`, `stem (2)`, `stem (3)`... whose `<stem><ext>` is free in `dir`.
 * `allow` is the caller's current name; `reserved` names count as taken.
 */
export async function uniqueName(
  dir: string,
  stem: string,
  ext: string,
  options: { allow?: string; reserved?: string[] } = {}
): Promise<string> {
  const reserved = new Set((options.reserved ?? []).map((r) => r.toLowerCase()))
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? stem : `${stem} (${n})`
    const lower = candidate.toLowerCase()
    if (reserved.has(lower)) continue
    // macOS volumes are usually case-insensitive, so a case-only rename must not collide with itself.
    if (options.allow !== undefined && lower === options.allow.toLowerCase()) return candidate
    const taken =
      (await exists(join(dir, candidate + ext))) ||
      (ext === '.md' && (await exists(join(dir, candidate))))
    if (!taken) return candidate
  }
}

export async function removeDirIfEmpty(dir: string): Promise<void> {
  try {
    if ((await readdir(dir)).length === 0) await rmdir(dir)
  } catch {
    // Missing or non-empty: nothing to do.
  }
}
