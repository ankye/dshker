import { contextBridge, ipcRenderer } from 'electron'
import {
  WORKBENCH_CHANNELS,
  isWorkbenchReply,
  isWorkbenchRequest,
  type WorkbenchGuestBridge
} from '../packages/dshker-workbench-client/src/protocol'

// This entry is only eligible for a main-owned, registered runtime guest.
// Main must never accept a renderer-selected preload path or arbitrary origin.
if (process.isMainFrame) {
  let subscribed = false
  const bridge: WorkbenchGuestBridge = Object.freeze({
    version: 1 as const,
    onRequest(listener: Parameters<WorkbenchGuestBridge['onRequest']>[0]) {
      if (subscribed) throw new Error('workbench.busy')
      subscribed = true
      const receive = (_event: unknown, payload: unknown): void => {
        if (!isWorkbenchRequest(payload)) throw new Error('workbench.invalid_request')
        listener(payload)
      }
      ipcRenderer.on(WORKBENCH_CHANNELS.request, receive)
      try {
        ipcRenderer.send(WORKBENCH_CHANNELS.ready, { version: 1, available: true })
      } catch (error) {
        ipcRenderer.removeListener(WORKBENCH_CHANNELS.request, receive)
        subscribed = false
        throw error
      }
      return () => {
        ipcRenderer.removeListener(WORKBENCH_CHANNELS.request, receive)
        subscribed = false
        ipcRenderer.send(WORKBENCH_CHANNELS.ready, { version: 1, available: false })
      }
    },
    reply(payload: Parameters<WorkbenchGuestBridge['reply']>[0]) {
      if (!isWorkbenchReply(payload)) throw new Error('workbench.invalid_request')
      ipcRenderer.send(WORKBENCH_CHANNELS.reply, payload)
    }
  })
  contextBridge.exposeInMainWorld('dshkerWorkbench', bridge)
}
