export const DEFAULT_MCP_PORT = 47321

export interface McpStatus {
  enabled: boolean
  /** Where Claude connects; null while the server is not listening. */
  url: string | null
  token: string | null
  /** Why the server could not start. */
  error: string | null
}

export function mcpAddCommand(url: string, token: string): string {
  return `claude mcp add --scope user --transport http nobsidian ${url} --header "Authorization: Bearer ${token}"`
}
