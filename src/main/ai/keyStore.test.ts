import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KeyStore, keyHint, type KeyCodec } from './keyStore'

const KEY = 'sk-ant-api03-secret-value-wxyz'
const codec: KeyCodec = {
  available: () => true,
  encrypt: (text) => Buffer.from([...Buffer.from(text)].reverse()),
  decrypt: (data) => Buffer.from([...data].reverse()).toString()
}

let dir: string
let file: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nobi-key-'))
  file = join(dir, 'nested', 'anthropic-key.json')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('KeyStore', () => {
  it('keeps the key encrypted and private on disk, and reads it back after a restart', async () => {
    await new KeyStore(file, codec).set(KEY)
    const raw = await readFile(file, 'utf8')
    expect(raw).not.toContain(KEY)
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    const reopened = new KeyStore(file, codec)
    expect(await reopened.get()).toBe(KEY)
    expect(await reopened.hint()).toBe('sk-ant-…wxyz')
  })

  it('forgets the key when cleared', async () => {
    const store = new KeyStore(file, codec)
    await store.set(KEY)
    await store.clear()
    expect(await store.get()).toBeNull()
    expect(await new KeyStore(file, codec).get()).toBeNull()
  })

  it('treats a missing or damaged key file as no key', async () => {
    expect(await new KeyStore(file, codec).get()).toBeNull()
    await new KeyStore(file, codec).set(KEY)
    await writeFile(file, '{"hint": 3')
    expect(await new KeyStore(file, codec).get()).toBeNull()
    await writeFile(file, JSON.stringify({ hint: 'x' }))
    expect(await new KeyStore(file, codec).hint()).toBeNull()
  })

  it('refuses to save without encryption, and rejects a key it cannot decrypt', async () => {
    const none = { ...codec, available: () => false }
    await expect(new KeyStore(file, none).set(KEY)).rejects.toThrow(
      'Encryption is not available on this Mac.'
    )
    await new KeyStore(file, codec).set(KEY)
    const denied: KeyCodec = {
      ...codec,
      decrypt: () => {
        throw new Error('Keychain access denied')
      }
    }
    const store = new KeyStore(file, denied)
    expect(await store.hint()).toBe('sk-ant-…wxyz')
    await expect(store.get()).rejects.toThrow('Keychain access denied')
  })
})

describe('keyHint', () => {
  it('shows only the last four characters', () => {
    expect(keyHint(KEY)).toBe('sk-ant-…wxyz')
    expect(keyHint('other-1234')).toBe('…1234')
  })
})
