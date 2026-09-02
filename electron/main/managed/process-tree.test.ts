import { describe, expect, it, vi } from 'vitest'
import { terminateManagedProcessTree } from './process-tree'

describe('terminateManagedProcessTree', () => {
  it('signals the detached POSIX process group rather than only pnpm', () => {
    const sendSignal = vi.fn()

    terminateManagedProcessTree(42, 'darwin', sendSignal)

    expect(sendSignal).toHaveBeenCalledWith(-42, 'SIGTERM')
  })

  it('signals the direct child on Windows', () => {
    const sendSignal = vi.fn()

    terminateManagedProcessTree(42, 'win32', sendSignal)

    expect(sendSignal).toHaveBeenCalledWith(42, 'SIGTERM')
  })

  it('rejects a missing child process identifier', () => {
    expect(() => terminateManagedProcessTree(undefined, 'darwin')).toThrow(
      'Managed DSH child has no process identifier.'
    )
  })
})
