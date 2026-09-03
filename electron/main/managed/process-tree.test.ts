import { describe, expect, it, vi } from 'vitest'
import { terminateManagedProcessTree } from './process-tree'

describe('terminateManagedProcessTree', () => {
  it('signals the detached POSIX process group rather than only pnpm', () => {
    const sendSignal = vi.fn()

    terminateManagedProcessTree(42, 'darwin', sendSignal)

    expect(sendSignal).toHaveBeenCalledWith(-42, 'SIGTERM')
  })

  it('terminates the full tree through taskkill on Windows', () => {
    const sendSignal = vi.fn()
    const terminateWindowsTree = vi.fn()

    terminateManagedProcessTree(42, 'win32', sendSignal, terminateWindowsTree)

    expect(terminateWindowsTree).toHaveBeenCalledWith(42)
    expect(sendSignal).not.toHaveBeenCalled()
  })

  it('rejects a missing child process identifier', () => {
    expect(() => terminateManagedProcessTree(undefined, 'darwin')).toThrow(
      'Managed DSH child has no process identifier.'
    )
  })
})
