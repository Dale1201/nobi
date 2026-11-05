import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileAtomic } from './fs-utils'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nobsidian-fs-utils-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
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
