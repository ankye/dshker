// The live half of the Launcher's DSH Web launch.
//
// The core owns the child, so the shell observes it instead of spawning it: this
// polls the core's bounded console feed by cursor, forwards what it reads to the
// renderer's own console, and reports every launch record the core publishes.
// It is separate from the service because the renderer's contract is a promise
// per operation plus a push per console record, and a poller is neither.
import type {
  CoreHarnessConsoleEntry,
  CoreHarnessLaunchView,
  CoreHarnessRuntimePort
} from '../core/harness-runtime'
import type { LauncherHarnessConsoleEntry } from '../../../src/shared/contracts'

/** How often the shell drains the core's console feed while a launch is live. */
export const CONSOLE_POLL_MILLISECONDS = 200

export interface LauncherRuntimeFeedOptions {
  /** Resolves the core's runtime port, or refuses when no core is reachable. */
  readonly runtime: () => Promise<CoreHarnessRuntimePort>
  /** The launch subject this feed follows. */
  readonly subjectId: string
  /** Receives one console record, already narrowed to the renderer's streams. */
  readonly onConsole: (stream: LauncherHarnessConsoleEntry['stream'], text: string) => void
  /** Receives every launch record the core publishes, including the final one. */
  readonly onLaunch: (view: CoreHarnessLaunchView) => void
  readonly intervalMilliseconds?: number
}

/** Polls one core launch record and its console feed until the launch ends. */
export class LauncherRuntimeFeed {
  readonly #options: LauncherRuntimeFeedOptions
  #cursor = 0
  #timer: ReturnType<typeof setInterval> | undefined

  constructor(options: LauncherRuntimeFeedOptions) {
    this.#options = options
  }

  /** Starts polling; a second call while polling is a no-op. */
  start(): void {
    if (this.#timer !== undefined) return
    const interval = this.#options.intervalMilliseconds ?? CONSOLE_POLL_MILLISECONDS
    this.#timer = setInterval(() => {
      void this.drain()
    }, interval)
  }

  /** Stops polling. The next start resumes from the cursor it reached. */
  stop(): void {
    if (this.#timer === undefined) return
    clearInterval(this.#timer)
    this.#timer = undefined
  }

  /** Reads one console page and one launch record. Never throws from a timer. */
  async drain(): Promise<void> {
    try {
      const runtime = await this.#options.runtime()
      const page = await runtime.console(this.#cursor)
      this.#cursor = page.cursor
      for (const entry of page.entries) this.#forward(entry)
      const view = await runtime.status(this.#options.subjectId)
      if (view === undefined) {
        this.stop()
        return
      }
      this.#options.onLaunch(view)
      if (view.state === 'stopped' || view.state === 'failed') this.stop()
    } catch {
      // A core that cannot be reached is reported by the next operation; a
      // console feed must not become an unhandled timer rejection.
    }
  }

  #forward(entry: CoreHarnessConsoleEntry): void {
    this.#options.onConsole(consoleStreamOf(entry.stream), entry.text)
  }
}

/** Narrows one core console stream name to the renderer's four known streams. */
export function consoleStreamOf(stream: string): LauncherHarnessConsoleEntry['stream'] {
  if (stream === 'stderr' || stream === 'command' || stream === 'launcher') return stream
  return 'stdout'
}
