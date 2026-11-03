import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import {
  localhostHostValidation,
  localhostOriginValidation,
  NodeStreamableHTTPServerTransport
} from '@modelcontextprotocol/node'
import type { McpServer } from '@modelcontextprotocol/server'

export const MCP_PATH = '/mcp'

function authorized(header: string | undefined, token: string): boolean {
  const given = Buffer.from(header ?? '')
  const expected = Buffer.from(`Bearer ${token}`)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

function reply(res: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'text/plain', ...headers }).end()
}

/** Serves MCP over Streamable HTTP on loopback, to clients holding the token. */
export class McpHttpServer {
  private server: Server | null = null
  private readonly validHost = localhostHostValidation()
  private readonly validOrigin = localhostOriginValidation()

  constructor(private readonly options: { token: () => string; createServer: () => McpServer }) {}

  /** Resolves with the port it listens on, which is chosen by the system for port 0. */
  listen(port: number): Promise<number> {
    const server = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        console.error('MCP request failed', err)
        if (!res.headersSent) reply(res, 500)
        else res.end()
      })
    })
    return new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject)
        server.on('error', (err) => console.error('MCP server error', err))
        this.server = server
        resolve((server.address() as AddressInfo).port)
      })
    })
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server) return
    const closed = new Promise<void>((resolve) => server.close(() => resolve()))
    server.closeAllConnections()
    await closed
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Stops web pages reaching the server through DNS rebinding or a cross-origin request.
    if (!this.validHost(req, res) || !this.validOrigin(req, res)) return
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== MCP_PATH) return reply(res, 404)
    if (!authorized(req.headers.authorization, this.options.token())) {
      return reply(res, 401, { 'WWW-Authenticate': 'Bearer' })
    }
    // Stateless: every request gets its own server and transport.
    const mcp = this.options.createServer()
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => {
      void transport.close()
      void mcp.close()
    })
    await mcp.connect(transport)
    await transport.handleRequest(req, res)
  }
}
