import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileAtomic, writeFileAtomic } from './fs-utils'

const failRename = vi.hoisted(() => ({ on: false }))
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  return {
    ...fs,
    rename: (from: string, to: string) =>
      failRename.on ? Promise.reject(new Error('disk full')) : fs.rename(from, to)
  }
})

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nobsidian-fs-utils-'))
})
afterEach(async () => {
  failRename.on = false
  await rm(root, { recursive: true, force: true })
})

describe('writeFileAtomic', () => {
  it('replaces the file whole, or leaves the old one and no temp file when it cannot', async () => {
    const file = join(root, 'Notes.md')
    await writeFile(file, 'old\n')
    await writeFileAtomic(file, 'new\n')
    expect(await readFile(file, 'utf8')).toBe('new\n')
    failRename.on = true
    await expect(writeFileAtomic(file, 'lost\n')).rejects.toThrow('disk full')
    expect(await readFile(file, 'utf8')).toBe('new\n')
    expect(await readdir(root)).toEqual(['Notes.md'])
  })
})

describe('createFileAtomic', () => {
  it('creates a missing file', async () => {
    expect(await createFileAtomic(join(root, 'Notes.md'), 'made\n')).toBe(true)
    expect(await readFile(join(root, 'Notes.md'), 'utf8')).toBe('made\n')
    expect(await readdir(root)).toEqual(['Notes.md'])
  })

  it('leaves a file that is already there untouched', async () => {
    await writeFile(join(root, 'Notes.md'), 'mine\n')
    expect(await createFileAtomic(join(root, 'Notes.md'), 'made\n')).toBe(false)
    expect(await readFile(join(root, 'Notes.md'), 'utf8')).toBe('mine\n')
    expect(await readdir(root)).toEqual(['Notes.md'])
  })
})
