import { handle } from '../ipc'
import type { McpService } from './service'

export function registerMcpHandlers(mcp: McpService): void {
  handle('mcp:status', () => mcp.status())
  handle('mcp:setEnabled', ({ enabled }) => mcp.setEnabled(enabled))
  handle('mcp:resetToken', () => mcp.resetToken())
}
