import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import type { IpcChannel, IpcEvents, IpcPayload, IpcResult } from '../shared/ipc'

/** End-to-end tests reach this through `app.evaluate` to count, hold back or fail IPC calls. */
export interface IpcProbe {
  calls: Record<string, number>
  wrap: Record<string, (call: () => Promise<unknown>, payload: unknown) => Promise<unknown>>
}

const probe: IpcProbe | undefined =
  process.env.NOBSIDIAN_E2E === '1' ? { calls: {}, wrap: {} } : undefined
if (probe) (globalThis as { nbIpc?: IpcProbe }).nbIpc = probe

export function handle<C extends IpcChannel>(
  channel: C,
  handler: (
    payload: IpcPayload<C>,
    event: IpcMainInvokeEvent
  ) => Promise<IpcResult<C>> | IpcResult<C>
): void {
  ipcMain.handle(channel, (event, payload: IpcPayload<C>) => {
    if (!probe) return handler(payload, event)
    probe.calls[channel] = (probe.calls[channel] ?? 0) + 1
    const wrap = probe.wrap[channel]
    const call = async (): Promise<unknown> => handler(payload, event)
    return wrap ? wrap(call, payload) : call()
  })
}

export function send<E extends keyof IpcEvents>(
  target: WebContents,
  event: E,
  data: IpcEvents[E]
): void {
  if (!target.isDestroyed()) target.send(event, data)
}
