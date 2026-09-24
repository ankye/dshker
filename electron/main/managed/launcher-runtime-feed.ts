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

/** How often the shell drains the core's console feed while output is arriving. */
export const CONSOLE_POLL_MILLISECONDS = 200

/**
 * The slowest the feed backs off to once a launch has gone quiet.
 *
 * A launch is talkative while it starts and nearly silent for the hours after. At
 * a fixed 200ms that silence still cost two core round trips every 200ms for as
 * long as DSH stayed up — ten a second, forever, with nothing to report. Backing
 * off to this bound cuts an idle launch to one drain every two seconds while
 * leaving startup output as immediate as before.
 */
export const CONSOLE_IDLE_POLL_MILLISECONDS = 2_000

/**
 * Empty reads required before the feed starts slowing down.
 *
 * Output arrives in bursts with short gaps inside them. Backing off on the first
 * empty page meant one gap mid-burst doubled the delay, so the fast rate was never
 * actually held while a launch was talking.
 */
export const QUIET_DRAINS_BEFORE_BACKOFF = 5

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
  #timer: ReturnType<typeof setTimeout> | undefined
  /** The delay the next drain is scheduled with; grows while the launch is quiet. */
  #delay = CONSOLE_POLL_MILLISECONDS
  /**
   * Consecutive drains that found nothing.
   *
   * Backing off on the first empty page was wrong: output arrives in bursts with
   * gaps inside them, so one empty read between two lines doubled the delay and
   * the feed never actually held the fast rate while a launch was talking. Only a
   * run of empty reads means the launch has genuinely gone quiet.
   */
  #quietDrains = 0
  /**
   * Invalidates an in-flight drain when a launch is stopped or the feed is
   * restarted. Without this fence, a status response that started before stop
   * could arrive afterwards and resurrect the old running state.
   */
  #generation = 0

  constructor(options: LauncherRuntimeFeedOptions) {
    this.#options = options
  }

  /** Starts polling; a second call while polling is a no-op. */
  start(): void {
    if (this.#timer !== undefined) return
    this.#generation += 1
    // A fresh launch is the talkative phase, so start at the fast rate whatever
    // the previous launch backed off to.
    this.#delay = this.#fastDelay()
    this.#quietDrains = 0
    this.#schedule()
  }

  /** Stops polling. The next start resumes from the cursor it reached. */
  stop(): void {
    this.#generation += 1
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer)
      this.#timer = undefined
    }
  }

  #fastDelay(): number {
    return this.#options.intervalMilliseconds ?? CONSOLE_POLL_MILLISECONDS
  }

  /**
   * Chains the next drain instead of holding a fixed interval.
   *
   * A self-scheduling timeout is what lets the delay change between drains, and it
   * also stops drains from overlapping when the core is slow to answer — an
   * interval would have queued another one on top.
   */
  #schedule(): void {
    this.#timer = setTimeout(() => {
      void this.drain().finally(() => {
        if (this.#timer === undefined) return
        this.#schedule()
      })
    }, this.#delay)
  }

  /** Reads one console page and one launch record. Never throws from a timer. */
  async drain(generation = this.#generation): Promise<void> {
    try {
      const runtime = await this.#options.runtime()
      const page = await runtime.console(this.#cursor)
      if (generation !== this.#generation) return
      this.#cursor = page.cursor
      // Output means the launch is active: hold the fast rate. Only a sustained
      // run of empty reads backs off, so a gap between two lines of a burst does
      // not slow the feed down mid-burst.
      if (page.entries.length > 0) {
        this.#quietDrains = 0
        this.#delay = this.#fastDelay()
      } else if (++this.#quietDrains >= QUIET_DRAINS_BEFORE_BACKOFF) {
        this.#delay = Math.min(this.#delay * 2, CONSOLE_IDLE_POLL_MILLISECONDS)
      }
      for (const entry of page.entries) {
        if (generation !== this.#generation) return
        this.#forward(entry)
      }
      const view = await runtime.status(this.#options.subjectId)
      if (generation !== this.#generation) return
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
