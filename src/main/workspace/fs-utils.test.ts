import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFileAtomic } from './fs-utils'

describe('createFileAtomic', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nb-fs-'))
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  it('creates the file whole when nothing is there', async () => {
    expect(await createFileAtomic(join(dir, 'A.md'), 'stub\n')).toBe(true)
    expect(await readFile(join(dir, 'A.md'), 'utf8')).toBe('stub\n')
    expect(await readdir(dir)).toEqual(['A.md'])
  })

  it('leaves a file another program wrote untouched', async () => {
    await writeFile(join(dir, 'A.md'), 'Intro.\n\nOutro.\n')
    expect(await createFileAtomic(join(dir, 'A.md'), 'stub\n')).toBe(false)
    expect(await readFile(join(dir, 'A.md'), 'utf8')).toBe('Intro.\n\nOutro.\n')
    expect(await readdir(dir)).toEqual(['A.md'])
  })
})
