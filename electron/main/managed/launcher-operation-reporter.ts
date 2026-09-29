import { createWriteStream, type WriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import nodePath from 'node:path'
import { ManagedHarnessRuntimeError } from './runtime-errors'
import {
  formatLauncherLifecycleEvent,
  formatLauncherOperationFailure,
  formatLauncherStepCompletion,
  formatLauncherStepHeartbeat
} from './launcher-console-format'

/**
 * A silent step re-asserts itself on this cadence once it has produced no
 * console output for the silence threshold; a busy feed silences the heartbeat.
 */
const STEP_HEARTBEAT_INTERVAL_MILLISECONDS = 10_000
const STEP_SILENCE_THRESHOLD_MILLISECONDS = 20_000

/** What the reporter needs from its owner to publish and time its records. */
export interface LauncherOperationReporterOptions {
  /** Operations append their records here; launches keep their own truncating handle. */
  readonly launchLogPath: string
  /** Blocks mutations while the main process is preparing the initial checkout. */
  readonly isOperationAdmissionBlocked?: () => boolean
  /** Receives each launcher-marked record's message text. */
  readonly emit: (message: string) => void
  /** Timestamp of the newest console entry, for heartbeat silence gating. */
  readonly lastConsoleAppendAt: () => number
}

/**
 * Records Launcher operations: start, per-step progress with heartbeats, and
 * failure reasons, on the console feed and in the durable log.
 *
 * The reporter owns its own append-mode log handle, so a force-quit during a
 * stalled operation leaves the last recorded step on disk, and a launch that
 * is already streaming keeps its separate truncating handle untouched.
 */
export class LauncherOperationReporter {
  readonly #options: LauncherOperationReporterOptions
  #stream: WriteStream | undefined
  #activeOperations = 0

  constructor(options: LauncherOperationReporterOptions) {
    this.#options = options
  }

  /** True while at least one Launcher-owned Git/build operation is running. */
  isActive(): boolean {
    return this.#activeOperations > 0
  }

  /** Runs one operation with start, success, and failure records. */
  async reportOperation<T>(
    description: string,
    operation: () => Promise<T>,
    options: { readonly allowWhileAdmissionBlocked?: boolean } = {}
  ): Promise<T> {
    // Claim synchronously before the first await. Version operations mutate the
    // same mirror, worktree directories, and active-version pointer; allowing
    // overlapping IPC calls can delete a directory another call is building.
    if (
      this.#activeOperations > 0 ||
      (this.#options.isOperationAdmissionBlocked?.() === true &&
        options.allowWhileAdmissionBlocked !== true)
    ) {
      throw new ManagedHarnessRuntimeError(
        'runtime.operation_in_progress',
        'Another DSH operation is already in progress.'
      )
    }
    this.#activeOperations += 1
    try {
      await this.#openOperationLog()
      this.event(`${description}…`)
      try {
        const result = await operation()
        this.event(`${description} completed.`)
        return result
      } catch (error) {
        this.event(formatLauncherOperationFailure(description, error))
        throw error
      } finally {
        this.#closeOperationLog()
      }
    } finally {
      this.#activeOperations -= 1
    }
  }

  /**
   * Runs one operation step, recording its start, elapsed completion, and
   * failure. While the step stays silent on the console, a heartbeat
   * re-asserts it, so a slow step never looks like a frozen one.
   */
  async loggedStep<T>(description: string, step: () => Promise<T>): Promise<T> {
    this.event(`${description}…`)
    const startedAt = Date.now()
    const heartbeat = setInterval(() => {
      if (Date.now() - this.#options.lastConsoleAppendAt() < STEP_SILENCE_THRESHOLD_MILLISECONDS) {
        return
      }
      this.event(formatLauncherStepHeartbeat(description, Date.now() - startedAt))
    }, STEP_HEARTBEAT_INTERVAL_MILLISECONDS)
    try {
      const result = await step()
      this.event(formatLauncherStepCompletion(description, Date.now() - startedAt))
      return result
    } catch (error) {
      this.event(formatLauncherOperationFailure(description, error))
      throw error
    } finally {
      clearInterval(heartbeat)
    }
  }

  /** Publishes one launcher-marked record to the console feed and the log. */
  event(message: string): void {
    const text = formatLauncherLifecycleEvent(message)
    this.#stream?.write(text)
    this.#options.emit(message)
  }

  async #openOperationLog(): Promise<void> {
    try {
      await mkdir(nodePath.dirname(this.#options.launchLogPath), { recursive: true })
      const stream = createWriteStream(this.#options.launchLogPath, { flags: 'a' })
      // An unwritable log must not take down the operation it explains.
      stream.on('error', () => {
        if (this.#stream === stream) this.#stream = undefined
      })
      this.#stream = stream
    } catch {
      this.#stream = undefined
    }
  }

  #closeOperationLog(): void {
    const stream = this.#stream
    this.#stream = undefined
    stream?.end()
  }
}
