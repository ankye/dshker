import { spawn } from 'node:child_process'

/** Sends a termination signal to the full tree rooted at one Launcher child. */
export function terminateManagedProcessTree(
  processId: number | undefined,
  platform: NodeJS.Platform,
  sendSignal: (target: number, signal: NodeJS.Signals) => void = process.kill,
  terminateWindowsTree: (target: number) => void = terminateWindowsProcessTree
): void {
  if (processId === undefined || !Number.isSafeInteger(processId) || processId <= 0) {
    throw new Error('Managed DSH child has no process identifier.')
  }
  // A detached POSIX child is the leader of its own group, so a negative pid
  // reaches pnpm and the DSH Node process it starts. Windows uses taskkill's
  // tree mode because Node's process.kill() cannot address descendants there.
  if (platform === 'win32') {
    terminateWindowsTree(processId)
    return
  }
  sendSignal(-processId, 'SIGTERM')
}

/** Starts a non-blocking Windows tree termination after a bounded operation expires. */
function terminateWindowsProcessTree(processId: number): void {
  const child = spawn('taskkill', ['/pid', String(processId), '/t', '/f'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  })
  // The command may be unavailable in a stripped-down Windows environment.
  // The timed-out operation has already rejected, so this diagnostic must not
  // become an unhandled main-process error.
  child.once('error', () => undefined)
  child.unref()
}
