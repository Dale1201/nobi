import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { costOf, monthKey, UsageLedger } from './usage'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nobi-usage-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

it('prices a typical action for each model', () => {
  const usage = { input_tokens: 2300, output_tokens: 450 }
  expect(costOf('claude-opus-5-5', usage)).toBeCloseTo(0.0182, 6)
  expect(costOf('claude-sonnet-5-5', usage)).toBeCloseTo(0.0091, 6)
  expect(costOf('claude-haiku-5-5', usage)).toBeCloseTo(0.000455, 7)
})

it('prices cache writes and reads at their own rates', () => {
  const usage = {
    input_tokens: 100,
    output_tokens: 0,
    cache_creation_input_tokens: 1_000_000,
    cache_read_input_tokens: 1_000_000
  }
  expect(costOf('claude-opus-5-5', usage)).toBeCloseTo(5 + 0.2 + 0.0004, 6)
  expect(costOf('claude-sonnet-5-5', usage)).toBeCloseTo(2.5 + 0.1 + 0.0002, 6)
})

it('prices a model it does not know at the dearest rates', () => {
  expect(costOf('claude-something-9', { input_tokens: 1_000_000, output_tokens: 0 })).toBe(10)
})

it('adds responses up per month and keeps them across restarts', async () => {
  const file = join(dir, 'ai-usage.json')
  const ledger = new UsageLedger(file)
  const october = new Date(2026, 9, 26)
  const november = new Date(2026, 10, 1)
  await ledger.add('claude-opus-5-5', { input_tokens: 2300, output_tokens: 450 }, october)
  await ledger.add('claude-opus-5-5', { input_tokens: 2300, output_tokens: 450 }, october)
  await ledger.add('claude-haiku-5-5', { input_tokens: 1000, output_tokens: 0 }, november)

  const again = new UsageLedger(file)
  const oct = await again.month(october)
  expect(oct.requests).toBe(2)
  expect(oct.inputTokens).toBe(4600)
  expect(oct.dollars).toBeCloseTo(0.0364, 6)
  expect((await again.month(november)).requests).toBe(1)
  expect((await again.month(new Date(2026, 11, 1))).requests).toBe(0)
  expect(monthKey(october)).toBe('2026-10')
})

it('starts empty when the file is missing or corrupt', async () => {
  expect((await new UsageLedger(join(dir, 'missing.json')).month()).dollars).toBe(0)
  for (const [i, text] of ['null', '[]', '{"2026-10": ', '7'].entries()) {
    const file = join(dir, `corrupt-${i}.json`)
    await writeFile(file, text)
    const ledger = new UsageLedger(file)
    expect((await ledger.month()).requests).toBe(0)
    await ledger.add('claude-opus-5-5', { input_tokens: 10, output_tokens: 1 })
    expect((await new UsageLedger(file).month()).requests).toBe(1)
  }
})
