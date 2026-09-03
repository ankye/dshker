import type { ChildProcess } from 'node:child_process'

const MANAGED_DSH_SHUTDOWN_TIMEOUT_MILLISECONDS = 5_000

/** Waits until one signalled child has definitely relinquished its listening sockets. */
export function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('Managed DSH process did not exit before the shutdown deadline.'))
    }, MANAGED_DSH_SHUTDOWN_TIMEOUT_MILLISECONDS)
    const cleanup = () => {
      clearTimeout(timer)
      child.removeListener('exit', onExit)
      child.removeListener('error', onError)
    }
    const onExit = () => {
      cleanup()
      resolve()
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    child.once('exit', onExit)
    child.once('error', onError)
  })
}
