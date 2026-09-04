import type { ChildProcess } from 'node:child_process'
import { parseAnnouncedWebUrl } from './announced-web-url'

/** Handlers for one launch child's observed output. */
export interface ChildOutputHandlers {
  /** Receives every non-empty fragment, before line buffering. */
  readonly onText: (stream: 'stdout' | 'stderr', text: string) => void
  /** Receives the URL the child announced, detected only from complete lines. */
  readonly onAnnouncedUrl: (url: string) => void
}

/**
 * Observes one DSH Web child's output.
 *
 * Child stdout arrives in arbitrary chunks that can split a line mid-URL, so
 * the announcement is only read from lines known to be complete. Adopting a
 * truncated URL would drop the session credential DSH puts in its query.
 */
export class ChildOutputObserver {
  readonly #handlers: ChildOutputHandlers
  #pendingLine = ''

  constructor(handlers: ChildOutputHandlers) {
    this.#handlers = handlers
  }

  /** Attaches to one child; nothing is observed before attachment. */
  attach(child: ChildProcess): void {
    child.stdout?.on('data', (chunk: unknown) => {
      this.#receive('stdout', chunk)
    })
    child.stderr?.on('data', (chunk: unknown) => {
      this.#receive('stderr', chunk)
    })
  }

  /** Clears partial-line buffering for a new launch. */
  reset(): void {
    this.#pendingLine = ''
  }

  #receive(stream: 'stdout' | 'stderr', chunk: unknown): void {
    const text = String(chunk)
    if (text.length === 0) return
    this.#handlers.onText(stream, text)
    this.#pendingLine += text
    const lines = this.#pendingLine.split('\n')
    this.#pendingLine = lines.pop() ?? ''
    for (const line of lines) this.#observeAnnouncement(line)
  }

  #observeAnnouncement(line: string): void {
    const url = parseAnnouncedWebUrl(line)
    if (url !== undefined) this.#handlers.onAnnouncedUrl(url)
  }
}
