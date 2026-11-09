import Anthropic from '@anthropic-ai/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeAnthropic, GOOD_KEY } from '../../../e2e/fakeAnthropic'
import type { AiModel, AiStart } from '../../shared/ai'
import type { IpcEvents } from '../../shared/ipc'
import { apiUrl } from './client'
import { KeyStore, type KeyCodec } from './keyStore'
import { AiService } from './service'
import { UsageLedger } from './usage'

const codec: KeyCodec = {
  available: () => true,
  encrypt: (text) => Buffer.from(text.split('').reverse().join('')),
  decrypt: (data) => data.toString().split('').reverse().join('')
}

type Event =
  | { name: 'ai:delta'; data: IpcEvents['ai:delta'] }
  | { name: 'ai:done'; data: IpcEvents['ai:done'] }
  | { name: 'ai:error'; data: IpcEvents['ai:error'] }

let dir: string
let fake: FakeAnthropic
let keys: KeyStore
let model: AiModel
let service: AiService
let events: Event[]

const send = <E extends Event['name']>(name: E, data: IpcEvents[E]): void => {
  events.push({ name, data } as Event)
}

const request = (over: Partial<AiStart> = {}): AiStart => ({
  sessionId: 's1',
  requestId: `r${events.length}-${Math.random()}`,
  title: 'Notes',
  markdown: '⟦selection⟧We spent the hour arguing.⟦/selection⟧',
  selection: true,
  skill: 'shorter',
  ...over
})

const deltas = (): string[] =>
  events.flatMap((e) => (e.name === 'ai:delta' ? [`${e.data.mode}:${e.data.text}`] : []))
const last = (): Event => events[events.length - 1]

const serviceWith = (keys: KeyStore): AiService =>
  new AiService({
    keys,
    usage: new UsageLedger(join(dir, 'usage.json')),
    model: () => model,
    client: (apiKey) => new Anthropic({ apiKey, baseURL: fake.url, maxRetries: 0 }),
    idleTimeoutMs: 300
  })

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nobi-ai-'))
  fake = await FakeAnthropic.start()
  keys = new KeyStore(join(dir, 'key.json'), codec)
  model = 'claude-opus-5-5'
  events = []
  service = serviceWith(keys)
})
afterEach(async () => {
  await fake.close()
  await rm(dir, { recursive: true, force: true })
})

describe('the key', () => {
  it('is checked with Anthropic before it is stored, encrypted', async () => {
    expect(await service.setKey('  ')).toEqual({ ok: false, error: 'Paste your API key first.' })
    expect(await service.setKey('sk-ant-wrong')).toEqual({
      ok: false,
      error: 'Anthropic rejected this key.'
    })
    expect((await service.status()).hasKey).toBe(false)
    expect(await service.setKey(` ${GOOD_KEY}\n`)).toEqual({ ok: true })
    const raw = await readFile(join(dir, 'key.json'), 'utf8')
    expect(raw).not.toContain(GOOD_KEY)
    expect((await stat(join(dir, 'key.json'))).mode & 0o777).toBe(0o600)
    expect(await new KeyStore(join(dir, 'key.json'), codec).get()).toBe(GOOD_KEY)
    const status = await service.status()
    expect(status).toEqual({
      hasKey: true,
      keyHint: 'sk-ant-…a1b2',
      month: { requests: 0, dollars: 0 }
    })
    expect(JSON.stringify(status)).not.toContain('test-key')
    await service.clearKey()
    expect((await service.status()).hasKey).toBe(false)
  })

  it('is refused when this Mac cannot encrypt it', async () => {
    const locked = new AiService({
      keys: new KeyStore(join(dir, 'k'), { ...codec, available: () => false }),
      usage: new UsageLedger(join(dir, 'u.json')),
      model: () => model
    })
    expect(await locked.setKey(GOOD_KEY)).toEqual({
      ok: false,
      error: "This Mac can't store the key safely, so it was not saved."
    })
  })

  it('is shown by its hint without touching the Keychain', async () => {
    const keychain = (): never => {
      throw new Error('touched the Keychain')
    }
    const locked = serviceWith(
      new KeyStore(join(dir, 'key.json'), {
        available: keychain,
        encrypt: keychain,
        decrypt: keychain
      })
    )
    expect(await locked.status()).toMatchObject({ hasKey: false, keyHint: null })
    await keys.set(GOOD_KEY)
    expect(await locked.status()).toMatchObject({ hasKey: true, keyHint: 'sk-ant-…a1b2' })
  })

  it('is asked of the Keychain again after it was refused', async () => {
    await keys.set(GOOD_KEY)
    let refuse = true
    const guarded = serviceWith(
      new KeyStore(join(dir, 'key.json'), {
        ...codec,
        decrypt: (data) => {
          if (refuse) throw new Error('User denied Keychain access')
          return codec.decrypt(data)
        }
      })
    )
    await guarded.start(request(), send)
    expect(last()).toMatchObject({
      name: 'ai:error',
      data: {
        kind: 'auth',
        message: "Couldn't read your API key from the Keychain. Try again and choose Allow."
      }
    })
    expect(fake.messages()).toHaveLength(0)
    refuse = false
    await guarded.start(request(), send)
    expect(last().name).toBe('ai:done')
  })

  it('without one, a request asks for it', async () => {
    await service.start(request(), send)
    expect(last()).toMatchObject({ name: 'ai:error', data: { kind: 'auth' } })
    expect(fake.messages()).toHaveLength(0)
  })
})

describe('requests', () => {
  beforeEach(async () => {
    await keys.set(GOOD_KEY)
  })

  it('stream the whole text so far, then finish and count the cost', async () => {
    fake.reply({ text: 'We argued.', chunks: 3 })
    await service.start(request(), send)
    expect(deltas()).toEqual(['edit:We a', 'edit:We argue', 'edit:We argued.'])
    expect(last().name).toBe('ai:done')
    const body = fake.messages()[0]
    expect(body).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 32000,
      output_config: { effort: 'low' },
      fallbacks: 'default',
      stream: true
    })
    expect(body).not.toHaveProperty('temperature')
    expect(body).not.toHaveProperty('tools')
    expect(fake.requests.at(-1)!.headers['anthropic-beta']).toContain(
      'server-side-fallback-2026-07-01'
    )
    const status = await service.status()
    expect(status.month.requests).toBe(1)
    expect(status.month.dollars).toBeCloseTo(0.0182, 6)
  })

  it('leave fallbacks off for Haiku, which has none', async () => {
    model = 'claude-haiku-5-5'
    await service.start(request(), send)
    expect(fake.messages()[0]).not.toHaveProperty('fallbacks')
    expect(fake.requests.at(-1)!.headers['anthropic-beta']).toBeUndefined()
  })

  it('stream a tool call as the mode Claude chose', async () => {
    fake.reply({ tool: { name: 'reply', markdown: 'QA means testing.' }, chunks: 2 })
    await service.start(request({ skill: undefined, instruction: 'what is QA?' }), send)
    const body = fake.messages()[0]
    expect((body.tools as { name: string }[]).map((t) => t.name)).toEqual(['edit', 'reply'])
    expect(body.tool_choice).toEqual({ type: 'auto' })
    expect(deltas().at(-1)).toBe('reply:QA means testing.')
    expect(deltas().every((d) => d.startsWith('reply:'))).toBe(true)
    expect(last().name).toBe('ai:done')
  })

  it('revise the last result in the same conversation', async () => {
    fake.reply({ text: 'We argued.' }, { text: 'The team debated.' })
    await service.start(request(), send)
    await service.start(
      request({ skill: undefined, instruction: 'more formal', followUp: true }),
      send
    )
    const second = fake.messages()[1].messages as { role: string; content: unknown }[]
    expect(second.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(second[1].content).toEqual([{ type: 'text', text: 'We argued.' }])
    expect(second[2].content).toEqual([
      { type: 'text', text: 'Revise your last result: more formal\nGive the whole revised result.' }
    ])
    expect(fake.messages()[1]).not.toHaveProperty('tools')
    expect(deltas().at(-1)).toBe('edit:The team debated.')
  })

  it('start a new conversation once the Writer ends', async () => {
    await service.start(request(), send)
    service.end('s1')
    await service.start(request({ followUp: true, skill: undefined, instruction: 'again' }), send)
    expect((fake.messages()[1].messages as unknown[]).length).toBe(1)
  })

  it('stop when cancelled, keeping what arrived', async () => {
    fake.reply({ text: 'We argued for an hour.', hold: true })
    const r = request()
    const running = service.start(r, send)
    await expect.poll(() => deltas().length).toBe(1)
    service.cancel(r.requestId)
    await running
    expect(last()).toEqual({ name: 'ai:done', data: { requestId: r.requestId } })
  })

  it('report a stalled stream as a network problem', async () => {
    fake.reply({ text: 'We argued for an hour.', hold: true })
    await service.start(request(), send)
    expect(last()).toMatchObject({ name: 'ai:error', data: { kind: 'network' } })
  })

  it('report errors before and during the stream', async () => {
    fake.reply(
      { status: 429, retryAfter: 7 },
      { text: 'We argued for an hour.', streamError: 'overloaded_error' },
      { text: 'We argued for an hour.', drop: true },
      { status: 400, errorMessage: 'Your credit balance is too low.' }
    )
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    for (let i = 0; i < 4; i++) await service.start(request(), send)
    // Only the dropped connection, which the SDK does not class as an API error.
    expect(logged).toHaveBeenCalledTimes(1)
    logged.mockRestore()
    const errors = events.flatMap((e) => (e.name === 'ai:error' ? [e.data.message] : []))
    expect(errors).toEqual([
      'Too many requests right now. Try again in 7 seconds.',
      'Claude is busy right now. Try again in a moment.',
      "Can't reach Anthropic. Check your internet connection.",
      'Anthropic said: Your credit balance is too low.'
    ])
  })

  it('say when Claude declined or ran out of room', async () => {
    fake.reply({ text: '', stopReason: 'refusal' }, { text: 'We argued', stopReason: 'max_tokens' })
    await service.start(request(), send)
    expect(last()).toMatchObject({
      data: { kind: 'refusal', message: 'Claude declined this request.' }
    })
    await service.start(request(), send)
    expect(last()).toMatchObject({
      data: { kind: 'truncated', message: 'The response was cut off.' }
    })
  })

  it('start afresh after a refusal that said nothing', async () => {
    fake.reply({ text: '', stopReason: 'refusal' }, { text: 'We argued.' })
    await service.start(request(), send)
    await service.start(
      request({ skill: undefined, instruction: 'try again', followUp: true }),
      send
    )
    const second = fake.messages()[1].messages as { role: string }[]
    expect(second.map((m) => m.role)).toEqual(['user'])
    expect(last().name).toBe('ai:done')
  })

  it('report a failure before the stream starts, without throwing', async () => {
    const broken = new AiService({
      keys,
      usage: new UsageLedger(join(dir, 'usage.json')),
      model: () => model,
      client: () => {
        throw new Error('no client')
      }
    })
    const r = request()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(broken.start(r, send)).resolves.toBeUndefined()
    expect(logged).toHaveBeenCalledWith('AI request failed:', new Error('no client'))
    logged.mockRestore()
    expect(events).toEqual([
      {
        name: 'ai:error',
        data: expect.objectContaining({ requestId: r.requestId, kind: 'network' })
      }
    ])
  })

  it('log a failure of its own while streaming, and report it', async () => {
    fake.reply({ text: 'We argued for an hour.' })
    const r = request()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failing: typeof send = (name, data) => {
      if (name === 'ai:delta') throw new Error('listener bug')
      send(name, data)
    }
    await expect(service.start(r, failing)).resolves.toBeUndefined()
    expect(logged).toHaveBeenCalledWith(
      'AI request failed:',
      expect.objectContaining({ message: 'listener bug' })
    )
    logged.mockRestore()
    expect(last()).toMatchObject({ name: 'ai:error', data: { requestId: r.requestId } })
  })

  it('never reach Anthropic when cancelled or ended while the key is still being read', async () => {
    const cold = (): AiService =>
      new AiService({
        keys: new KeyStore(join(dir, 'key.json'), codec),
        usage: new UsageLedger(join(dir, 'usage.json')),
        model: () => model,
        client: (apiKey) => new Anthropic({ apiKey, baseURL: fake.url, maxRetries: 0 })
      })
    const stops = [
      (ai: AiService, r: AiStart) => ai.cancel(r.requestId),
      (ai: AiService, r: AiStart) => ai.end(r.sessionId)
    ]
    for (const stop of stops) {
      const ai = cold()
      const r = request()
      const running = ai.start(r, send)
      stop(ai, r)
      await running
      expect(last()).toEqual({ name: 'ai:done', data: { requestId: r.requestId } })
    }
    expect(fake.messages()).toHaveLength(0)
  })

  it('stop the running request when the Writer ends', async () => {
    fake.reply({ text: 'We argued for an hour.', hold: true })
    const r = request()
    const running = service.start(r, send)
    await expect.poll(() => deltas().length).toBe(1)
    service.end('s1')
    await running
    expect(last()).toEqual({ name: 'ai:done', data: { requestId: r.requestId } })
    await expect.poll(() => fake.streaming).toBe(0)
  })

  it('bill a stopped stream for at least the text that arrived', async () => {
    fake.reply({ text: 'x'.repeat(300), chunks: 2, hold: true })
    const r = request()
    const running = service.start(r, send)
    await expect.poll(() => deltas().length).toBe(1)
    service.cancel(r.requestId)
    await running
    const month = await new UsageLedger(join(dir, 'usage.json')).month()
    expect(month.outputTokens).toBeGreaterThanOrEqual(50)
  })

  it('price the model that answered, which a fallback can change', async () => {
    fake.reply({
      text: 'x',
      model: 'claude-opus-4-8',
      usage: { input_tokens: 1_000_000, output_tokens: 0 }
    })
    await service.start(request(), send)
    expect((await service.status()).month.dollars).toBeCloseTo(5, 6)
  })
})

it('only lets tests point the client at another server', () => {
  expect(apiUrl({ NOBI_AI_BASE_URL: 'http://evil' })).toBe('https://api.anthropic.com')
  expect(apiUrl({ ANTHROPIC_BASE_URL: 'http://evil' })).toBe('https://api.anthropic.com')
  expect(apiUrl({ NOBI_E2E: '1', NOBI_AI_BASE_URL: 'http://127.0.0.1:9' })).toBe(
    'http://127.0.0.1:9'
  )
})
