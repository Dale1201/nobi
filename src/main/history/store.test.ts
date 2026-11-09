import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HistoryStore } from './store'

let root: string
let clock: Date
const meta = { path: 'Page.md', links: {} }

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nobi-history-'))
  clock = new Date('2026-10-21T10:00:00.000Z')
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const store = (): HistoryStore => new HistoryStore(root, () => clock)
const files = (id: string): Promise<string[]> =>
  readdir(join(root, '.nobi', 'history', id)).then((f) => f.sort())

describe('HistoryStore', () => {
  it('never recreates a workspace folder that has gone', async () => {
    const h = store()
    await rm(root, { recursive: true, force: true })
    await expect(h.save('p', 'x', meta)).rejects.toThrow('Folder not found')
    expect(await stat(root).catch(() => null)).toBeNull()
  })

  it('saves snapshots with a sidecar, newest first, skipping unchanged text', async () => {
    const h = store()
    expect(await h.save('p', 'one', meta)).toEqual({
      id: '2026-10-21T10-00-00-000Z',
      at: '2026-10-21T10:00:00.000Z'
    })
    expect(await h.save('p', 'one', meta)).toBeNull()
    clock = new Date('2026-10-21T10:05:00.000Z')
    await h.save('p', 'two', { path: 'Moved.md', links: { 'Other.md': 'o' } })
    expect((await h.list('p')).map((v) => v.id)).toEqual([
      '2026-10-21T10-05-00-000Z',
      '2026-10-21T10-00-00-000Z'
    ])
    expect(await h.read('p', '2026-10-21T10-05-00-000Z')).toEqual({
      text: 'two',
      meta: { path: 'Moved.md', links: { 'Other.md': 'o' } }
    })
    expect(await files('p')).toEqual([
      '2026-10-21T10-00-00-000Z.json',
      '2026-10-21T10-00-00-000Z.md',
      '2026-10-21T10-05-00-000Z.json',
      '2026-10-21T10-05-00-000Z.md'
    ])
  })

  it('remembers the newest snapshot across restarts', async () => {
    await store().save('p', 'same', meta)
    expect(await store().save('p', 'same', meta)).toBeNull()
  })

  it('never overwrites a snapshot taken in the same millisecond', async () => {
    const h = store()
    await h.save('p', 'a', meta)
    await h.save('p', 'b', meta)
    expect((await h.list('p')).map((v) => v.id)).toEqual([
      '2026-10-21T10-00-00-001Z',
      '2026-10-21T10-00-00-000Z'
    ])
  })

  it('keeps 30 days in full and the newest snapshot of each older day', async () => {
    const h = store()
    const at = (iso: string, text: string): Promise<unknown> => {
      clock = new Date(iso)
      return h.save('p', text, meta)
    }
    await at('2026-09-01T09:00:00.000Z', 'a')
    await at('2026-09-01T11:00:00.000Z', 'b')
    await at('2026-09-02T09:00:00.000Z', 'c')
    await at('2026-10-15T09:00:00.000Z', 'd')
    await at('2026-10-15T10:00:00.000Z', 'e')
    clock = new Date('2026-10-21T12:00:00.000Z')
    await h.prune()
    expect((await h.list('p')).map((v) => v.at)).toEqual([
      '2026-10-15T10:00:00.000Z',
      '2026-10-15T09:00:00.000Z',
      '2026-09-02T09:00:00.000Z',
      '2026-09-01T11:00:00.000Z'
    ])
    expect(await files('p')).toHaveLength(8)
  })

  it('removes the history of deleted pages', async () => {
    const h = store()
    await h.save('p', 'x', meta)
    await h.remove(['p'])
    expect(await h.list('p')).toEqual([])
    expect(await h.save('p', 'x', meta)).not.toBeNull()
  })

  it('rejects version ids that could escape the history folder', async () => {
    await expect(store().read('p', '../../workspace')).rejects.toThrow('Unknown version')
  })

  it('rejects page ids that could escape the history folder', async () => {
    const h = store()
    await expect(h.save('../..', 'x', meta)).rejects.toThrow('Unknown page')
    await expect(h.remove(['../..'])).rejects.toThrow('Unknown page')
    await expect(h.list('a/b')).rejects.toThrow('Unknown page')
    expect(await readdir(root)).toEqual([])
  })
})
