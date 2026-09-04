import type { ChildProcess } from 'node:child_process'
import { ManagedHarnessRuntimeError } from './runtime-errors'
import { waitForChildExit } from './child-exit'
import { terminateManagedProcessTree } from './process-tree'

/**
 * Signals the owned pnpm process group and waits for its root child to exit.
 *
 * Shared by the interactive stop and the application shutdown path, so both
 * refuse to report success before the managed tree is actually gone.
 */
export async function terminateManagedChild(child: ChildProcess): Promise<void> {
  const exited = waitForChildExit(child)
  try {
    terminateManagedProcessTree(child.pid, process.platform)
  } catch (error) {
    throw new ManagedHarnessRuntimeError(
      'runtime.child_unavailable',
      error instanceof Error ? error.message : 'Managed DSH process could not be stopped.'
    )
  }
  try {
    await exited
  } catch (error) {
    throw new ManagedHarnessRuntimeError(
      'runtime.shutdown_timeout',
      error instanceof Error ? error.message : 'Managed DSH process did not exit after SIGTERM.'
    )
  }
}
