import { describe, expect, it, vi } from 'vitest'

/**
 * The renderer can only explain what it can distinguish.
 *
 * These tests pin the IPC error-code mapping because it regressed invisibly:
 * every distinct Harness failure was collapsed into
 * `managed.harness_launch_failed`, so a refused version switch — "stop DSH Web
 * first" — was reported to the user as "the core failed to start", and the full
 * suite stayed green throughout.
 *
 * The handler is exercised through the real mapping table rather than by
 * re-implementing it here, so a mapping change has to update this file too.
 */
describe('launcher harness error codes', () => {
  /** Loads the mapping the IPC layer actually uses. */
  async function loadMapping(): Promise<Readonly<Record<string, string>>> {
    vi.resetModules()
    const source = await import('./ipc-error-codes')
    return source.LAUNCHER_HARNESS_ERROR_CODES
  }
  it('reports a refused version switch while DSH Web runs as busy, not as a launch failure', async () => {
    const codes = await loadMapping()
    expect(codes['runtime.busy_running']).toBe('managed.harness_busy_running')
  })

  it('reports a plugin CLI refusal as a plugin failure', async () => {
    const codes = await loadMapping()
    expect(codes['runtime.plugin_operation_failed']).toBe('managed.harness_plugin_operation_failed')
  })

  it('reports an unusable checkout and an invalid selection under their own codes', async () => {
    const codes = await loadMapping()
    expect(codes['runtime.worktree_invalid']).toBe('managed.harness_worktree_invalid')
    expect(codes['runtime.input_invalid']).toBe('managed.harness_input_invalid')
  })

  it('covers every runtime code the service can throw, so none fall to the generic bucket by accident', async () => {
    const source = await import('./ipc-error-codes')
    const codes = source.LAUNCHER_HARNESS_ERROR_CODES
    for (const code of source.RUNTIME_ERROR_CODES) {
      expect(
        codes[code as keyof typeof codes],
        `${code} must have an explicit mapping`
      ).toBeDefined()
    }
  })

  it('maps a still-running launch attempt to the in-progress code', async () => {
    const codes = await loadMapping()
    expect(codes['runtime.operation_in_progress']).toBe('managed.harness_launch_in_progress')
  })
})
