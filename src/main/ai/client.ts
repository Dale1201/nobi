import Anthropic from '@anthropic-ai/sdk'

export const API_URL = 'https://api.anthropic.com'

export function apiUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.NOBI_E2E === '1' && env.NOBI_AI_BASE_URL) || API_URL
}

// The base URL is always passed, so ANTHROPIC_BASE_URL in the user's environment cannot send
// their key elsewhere; an explicit key also stops the SDK reading any other credential.
// No retries: a retry waits out the server's retry-after while the Writer says nothing.
export function createClient(apiKey: string): Anthropic {
  return new Anthropic({ apiKey, baseURL: apiUrl(), maxRetries: 0 })
}
