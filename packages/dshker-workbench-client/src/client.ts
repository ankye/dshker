import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import { createNavigationOwner } from './adapter'
import { bindWorkbench } from './channel'
import { WorkbenchError } from './navigation'
import type { WorkbenchGuestBridge } from './protocol'

declare global {
  interface Window {
    readonly dshkerWorkbench?: WorkbenchGuestBridge
  }
}

/** DSH public services required by this client-only extension. */
export const inject = ['sessions', 'workspaces']

/** Install a guest-specific navigation service using the isolated preload. */
export function apply(ctx: Context): void {
  const bridge = window.dshkerWorkbench
  if (!bridge || bridge.version !== 1) throw new WorkbenchError('workbench.unavailable')
  ctx.effect(
    () => bindWorkbench(bridge, createNavigationOwner(ctx.sessions, ctx.workspaces), 10_000),
    'dshker-workbench: scoped navigation'
  )
}
