import type { LauncherHarnessConsoleEntry } from '@/shared/contracts'

export type ConsoleSeverity = 'normal' | 'error'

export interface ConsoleOutputPart {
  readonly text: string
  readonly severity: ConsoleSeverity
}

/** Presentation only: stderr is a transport, not an error level. */
function lineSeverity(
  text: string,
  stream: LauncherHarnessConsoleEntry['stream']
): ConsoleSeverity {
  if (stream === 'command') return 'normal'
  const line = text
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '')
    .trimStart()
    .replace(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?\s+/u, '')

  // An explicit logger level wins over words quoted inside its message.
  const level =
    /^(?:\[(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL|D|I|S|W|E)\]|(TRACE|DEBUG|INFO|WARN|WARNING|ERROR|FATAL)(?=[:\s]))/iu.exec(
      line
    )
  if (level !== null) {
    return /^(?:E|ERROR|FATAL)$/iu.test(level[1] ?? level[2]) ? 'error' : 'normal'
  }

  if (stream === 'launcher') {
    if (/\b(?:failed:|child error:|could not be created:)/u.test(line)) return 'error'
    const exit = /process exited \(code=(none|-?\d+) signal=([A-Z0-9]+|none)\)/u.exec(line)
    if (exit !== null) {
      return exit[1] === '0' || exit[2] === 'SIGTERM' || exit[2] === 'SIGINT' ? 'normal' : 'error'
    }
  }

  if (
    /^(?:(?:[\w$]*Error|Exception):|fatal:|panic:|(?:npm|pnpm)\s+(?:ERR!(?=\s|$)|error\b)|ERR_[A-Z0-9_]+\b|E[A-Z]{3,}\b)/u.test(
      line
    ) ||
    /:\s+error TS\d+:/u.test(line)
  )
    return 'error'
  return 'normal'
}

/** Keeps every byte and newline; mixed chunks are colored one line at a time. */
export function consoleOutputParts(
  entry: LauncherHarnessConsoleEntry
): readonly ConsoleOutputPart[] {
  const parts: ConsoleOutputPart[] = []
  let previous: ConsoleSeverity = 'normal'
  for (const match of entry.text.matchAll(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/gu)) {
    const text = match[0]
    const severity: ConsoleSeverity =
      previous === 'error' && /^\s+at\s/u.test(text) ? 'error' : lineSeverity(text, entry.stream)
    parts.push({ text, severity })
    previous = severity
  }
  return parts
}
