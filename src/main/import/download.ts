import { extname } from 'node:path'

const TIMEOUT_MS = 20_000
const MAX_BYTES = 25 * 1024 * 1024

/** An image from the web, with a file name for it; throws when it is not a reasonable image. */
export async function downloadImage(
  url: string,
  fetchFn: typeof fetch = fetch,
  cancel?: AbortSignal
): Promise<{ name: string; data: Uint8Array }> {
  if (!/^https?:/i.test(url)) throw new Error('Not a web address')
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  const signal = cancel ? AbortSignal.any([cancel, timeout]) : timeout
  const response = await fetchFn(testOrigin(url), { signal })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`HTTP ${response.status}`)
  }
  const type = response.headers.get('content-type') ?? ''
  if (!type.startsWith('image/')) {
    await response.body?.cancel()
    throw new Error(`Not an image: ${type}`)
  }
  if (Number(response.headers.get('content-length') ?? 0) > MAX_BYTES) {
    await response.body?.cancel()
    throw new Error('Too large')
  }
  const data = await readCapped(response.body)
  let name = new URL(url).pathname.split('/').pop() ?? ''
  try {
    name = decodeURIComponent(name)
  } catch {
    // Keep it encoded.
  }
  if (!extname(name)) name = `${name || 'image'}.${type.slice(6).split(/[+;]/)[0]}`
  return { name, data }
}

/** Reads at most MAX_BYTES, whatever content-length says. */
async function readCapped(body: ReadableStream<Uint8Array> | null): Promise<Uint8Array> {
  if (!body) return new Uint8Array()
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_BYTES) {
      await reader.cancel()
      throw new Error('Too large')
    }
    chunks.push(value)
  }
  const data = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    data.set(chunk, offset)
    offset += chunk.byteLength
  }
  return data
}

/** End-to-end tests serve "web" images from a local server instead of the internet. */
function testOrigin(url: string): string {
  const origin = process.env.NOBI_E2E === '1' ? process.env.NOBI_E2E_WEB : undefined
  if (!origin) return url
  const u = new URL(url)
  return origin + u.pathname + u.search
}
