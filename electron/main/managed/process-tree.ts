/** Sends a termination signal to the full tree rooted at one Launcher child. */
export function terminateManagedProcessTree(
  processId: number | undefined,
  platform: NodeJS.Platform,
  sendSignal: (target: number, signal: NodeJS.Signals) => void = process.kill
): void {
  if (processId === undefined || !Number.isSafeInteger(processId) || processId <= 0) {
    throw new Error('Managed DSH child has no process identifier.')
  }
  // A detached POSIX child is the leader of its own group, so a negative pid
  // reaches pnpm and the DSH Node process it starts. Windows does not expose
  // that signal-group form through Node, so its direct child receives SIGTERM.
  sendSignal(platform === 'win32' ? processId : -processId, 'SIGTERM')
}
