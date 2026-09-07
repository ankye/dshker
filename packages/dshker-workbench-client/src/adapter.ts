import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { WorkbenchError, type NavigationOwner } from './navigation'

/** Bind only public DSH service methods; use ids read from their typed snapshots. */
export function createNavigationOwner(
  sessions: ISessions,
  workspaces: IWorkspaces
): NavigationOwner {
  return {
    refreshSessions: () => sessions.refresh(),
    targetState(target) {
      const list = sessions.list.getSnapshot()
      const projects = workspaces.list.getSnapshot()
      if (projects.state === 'error') throw new WorkbenchError('workbench.unavailable')
      if (list.phase !== 'ready' || projects.phase !== 'ready') return 'pending'
      const session = Object.values(list.byId).find((item) => item.id === target.sessionId)
      if (!session) return 'missing'
      const workspace = projects.items.find((item) => item.workspaceId === target.workspaceId)
      // Workspace follow may arrive after session.refresh; wait for its owned event.
      if (!workspace || !workspace.sessionIds.some((id) => id === session.id)) return 'pending'
      if (workspace.path !== target.path || session.cwd !== target.path) return 'mismatch'
      return 'ready'
    },
    subscribe(listener) {
      const stopSessions = sessions.list.subscribe(listener)
      let stopWorkspaces: () => void
      try {
        stopWorkspaces = workspaces.list.subscribe(listener)
      } catch (error) {
        stopSessions()
        throw error
      }
      return () => {
        stopSessions()
        stopWorkspaces()
      }
    },
    openSession(sessionId) {
      const id = sessions.list.getSnapshot().ids.find((value) => value === sessionId)
      if (!id) throw new WorkbenchError('workbench.session_missing')
      sessions.open(id)
    },
    selected() {
      const list = sessions.list.getSnapshot()
      const projects = workspaces.list.getSnapshot()
      if (
        list.phase !== 'ready' ||
        projects.phase !== 'ready' ||
        projects.state === 'error' ||
        !list.current
      )
        return undefined
      const session = list.byId[list.current]
      if (!session) return undefined
      const matches = projects.items.filter((item) => item.sessionIds.includes(session.id))
      if (matches.length !== 1 || matches[0]!.path !== session.cwd) return undefined
      return { workspaceId: matches[0]!.workspaceId, sessionId: session.id, path: matches[0]!.path }
    }
  }
}
