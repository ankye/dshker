import { appendFile } from 'node:fs/promises'

/**
 * Records why the application died.
 *
 * A window that vanishes used to leave nothing behind. A crashed renderer, a GPU
 * process that fell over, and a main process that hit an uncaught exception all
 * ended the same way from the user's side — the window was simply gone — and the
 * only evidence was their word for it. Electron reports the reason for each kind
 * of death, and this writes it down before the process goes, so the next report
 * can be answered from the file instead of from a guess.
 *
 * Deaths that the application survives (a renderer or a child process) are
 * recorded and nothing more: Electron already handles them, and exiting here would
 * turn a recoverable loss into a shutdown. An uncaught exception is different —
 * the main process is in an unknown state, Node's own default ended the process —
 * so it is recorded and then ended deliberately, with the same exit code the
 * default would have produced.
 */
export interface FaultTraceApp {
  on(event: 'render-process-gone', listener: RendererGoneListener): unknown
  on(event: 'child-process-gone', listener: ChildGoneListener): unknown
  exit(code: number): void
}

export interface RendererGoneDetails {
  reason: string
  exitCode: number
}

export interface RendererGoneContents {
  getURL(): string
  getType(): string
}

export type RendererGoneListener = (
  event: unknown,
  contents: RendererGoneContents,
  details: RendererGoneDetails
) => void

export interface ChildGoneDetails {
  type: string
  reason: string
  exitCode: number
  serviceName?: string
  name?: string
}

export type ChildGoneListener = (event: unknown, details: ChildGoneDetails) => void

/** The process-level events, kept structural so a test can supply its own. */
export interface FaultTraceProcess {
  on(event: 'uncaughtException', listener: (error: unknown) => void): unknown
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown
}

/** One recorded death, as a single log line with the detail that identifies it. */
export function formatRendererGone(
  details: RendererGoneDetails,
  contents: RendererGoneContents
): string {
  const window = contents.getURL() === '' ? contents.getType() : contents.getURL()
  return `renderer gone: ${details.reason} (exit ${details.exitCode}) while showing ${window}`
}

export function formatChildGone(details: ChildGoneDetails): string {
  const name = details.name ?? details.serviceName
  const label = name === undefined || name === '' ? details.type : `${details.type} ${name}`
  return `child process gone: ${label} (${details.reason}, exit ${details.exitCode})`
}

export function formatMainFault(
  kind: 'uncaughtException' | 'unhandledRejection',
  value: unknown
): string {
  const detail =
    value instanceof Error
      ? `${value.name}: ${value.message}`
      : typeof value === 'string'
        ? value
        : // A non-Error rejection carries no stack, so its shape is the only clue.
          (() => {
            try {
              return JSON.stringify(value)
            } catch {
              return String(value)
            }
          })()
  return `main process ${kind}: ${detail}`
}

/**
 * Registers the trace. `write` is the sink, so the file layout and the rotation of
 * the launcher's own log stay in one place and this module stays testable.
 */
export function installFaultTrace(options: {
  app: FaultTraceApp
  faults: FaultTraceProcess
  write: (message: string) => void
}): void {
  const { app, faults, write } = options
  app.on('render-process-gone', (_event, contents, details) => {
    write(formatRendererGone(details, contents))
  })
  app.on('child-process-gone', (_event, details) => {
    write(formatChildGone(details))
  })
  faults.on('uncaughtException', (error) => {
    write(formatMainFault('uncaughtException', error))
    app.exit(1)
  })
  faults.on('unhandledRejection', (reason) => {
    write(formatMainFault('unhandledRejection', reason))
  })
}

/** Appends one timestamped line. A failed write must not become a second fault. */
export function appendFaultLine(logPath: string, message: string): void {
  const line = `[launcher] ${new Date().toISOString()} ${message}\n`
  void appendFile(logPath, line, 'utf8').catch(() => undefined)
}
