/**
 * The IPC error-code mapping for Launcher-owned Harness operations.
 *
 * Extracted from `ipc.ts` so a test can hold it to account: when every
 * distinct failure was collapsed into `managed.harness_launch_failed` inside
 * the handler, no test could see it, and "stop DSH Web first" reached the user
 * as "the core failed to start".
 * @module
 */

import type { ManagedOperationErrorCode } from '../../../src/shared/contracts'
import type { ManagedHarnessRuntimeErrorCode } from './runtime-errors'

/** Every runtime code the service can throw, in one enumerable list. */
export const RUNTIME_ERROR_CODES: readonly ManagedHarnessRuntimeErrorCode[] = [
  'runtime.input_invalid',
  'runtime.node_invalid',
  'runtime.worktree_invalid',
  'runtime.descriptor_invalid',
  'runtime.descriptor_write_failed',
  'runtime.spawn_failed',
  'runtime.child_unavailable',
  'runtime.protocol_invalid',
  'runtime.protocol_mismatch',
  'runtime.handshake_timeout',
  'runtime.ready_timeout',
  'runtime.shutdown_timeout',
  'runtime.child_crashed',
  'runtime.operation_in_progress',
  'runtime.busy_running',
  'runtime.plugin_operation_failed',
  'runtime.not_found'
] as const

/**
 * Maps one Harness runtime failure to the code the renderer explains to the
 * user.
 *
 * A cause must keep its own code unless it genuinely is a launch failure.
 * Refusals with a distinct remedy — DSH Web still running, an unusable
 * checkout, an invalid selection, a rejected plugin command — read as launch
 * failures only when their remedy is lost.
 */
export const LAUNCHER_HARNESS_ERROR_CODES: Readonly<
  Record<ManagedHarnessRuntimeErrorCode, ManagedOperationErrorCode>
> = {
  'runtime.input_invalid': 'managed.harness_input_invalid',
  'runtime.busy_running': 'managed.harness_busy_running',
  'runtime.operation_in_progress': 'managed.harness_launch_in_progress',
  'runtime.worktree_invalid': 'managed.harness_worktree_invalid',
  'runtime.plugin_operation_failed': 'managed.harness_plugin_operation_failed',
  'runtime.node_invalid': 'managed.harness_launch_failed',
  'runtime.descriptor_invalid': 'managed.harness_launch_failed',
  'runtime.descriptor_write_failed': 'managed.harness_launch_failed',
  'runtime.spawn_failed': 'managed.harness_launch_failed',
  'runtime.child_unavailable': 'managed.harness_launch_failed',
  'runtime.protocol_invalid': 'managed.harness_launch_failed',
  'runtime.protocol_mismatch': 'managed.harness_launch_failed',
  'runtime.handshake_timeout': 'managed.harness_launch_failed',
  'runtime.ready_timeout': 'managed.harness_launch_failed',
  'runtime.shutdown_timeout': 'managed.harness_launch_failed',
  'runtime.child_crashed': 'managed.harness_launch_failed',
  'runtime.not_found': 'managed.harness_launch_failed'
}
