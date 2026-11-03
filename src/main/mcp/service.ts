import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'
import type { McpStatus } from '../../shared/mcp'
import type { SettingsStore } from '../settings'
import { McpHttpServer, MCP_PATH } from './http'
import { createNotesServer, type NotesAccess } from './tools'

export interface McpServiceOptions {
  settings: SettingsStore
  /** Holds the token in plain text: the Claude config that uses it does too. */
  tokenFile: string
  defaultPort: number
  access: NotesAccess
  version: string
}

/** Turns the Claude connector on and off, and keeps its port and token. */
export class McpService {
  private readonly http: McpHttpServer
  private token: string | null = null
  private port: number | null = null
  private error: string | null = null
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly options: McpServiceOptions) {
    this.http = new McpHttpServer({
      token: () => this.token ?? '',
      createServer: () => createNotesServer(options.access, options.version)
    })
  }

  status(): McpStatus {
    const enabled = this.options.settings.get().mcp.enabled
    const url = enabled && this.port !== null ? `http://127.0.0.1:${this.port}${MCP_PATH}` : null
    return { enabled, url, token: url ? this.token : null, error: enabled ? this.error : null }
  }

  /** Starts the server if the user turned the connector on. */
  start(): Promise<McpStatus> {
    return this.run(async () => {
      if (this.options.settings.get().mcp.enabled) await this.listen()
    })
  }

  setEnabled(enabled: boolean): Promise<McpStatus> {
    return this.run(async () => {
      await this.saveSettings({ enabled })
      if (enabled) await this.listen()
      else await this.stop()
    })
  }

  resetToken(): Promise<McpStatus> {
    return this.run(async () => {
      await this.writeToken()
    })
  }

  stop(): Promise<void> {
    this.port = null
    this.error = null
    return this.http.close()
  }

  private run(task: () => Promise<void>): Promise<McpStatus> {
    const next = this.queue.then(task).then(() => this.status())
    this.queue = next.catch(() => {})
    return next
  }

  private async listen(): Promise<void> {
    await this.stop()
    try {
      this.token ??= await this.readToken()
      const saved = this.options.settings.get().mcp.port
      this.port = await this.http.listen(saved ?? this.options.defaultPort).catch((err) => {
        // The default port can be swapped for a free one until a client has been set up with it.
        if (saved !== undefined || (err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err
        return this.http.listen(0)
      })
      if (this.port !== saved) await this.saveSettings({ port: this.port })
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      this.error =
        e.code === 'EADDRINUSE'
          ? `Port ${this.options.settings.get().mcp.port} is in use by another app.`
          : `The connector couldn't start: ${e.message}`
    }
  }

  private async saveSettings(patch: { enabled?: boolean; port?: number }): Promise<void> {
    await this.options.settings.set({ mcp: { ...this.options.settings.get().mcp, ...patch } })
  }

  private async readToken(): Promise<string> {
    const saved = await readFile(this.options.tokenFile, 'utf8').catch(() => '')
    return /^[0-9a-f]{64}$/.test(saved.trim()) ? saved.trim() : this.writeToken()
  }

  private async writeToken(): Promise<string> {
    const token = randomBytes(32).toString('hex')
    await mkdir(dirname(this.options.tokenFile), { recursive: true })
    await writeFile(this.options.tokenFile, token + '\n', { mode: 0o600 })
    this.token = token
    return token
  }
}
