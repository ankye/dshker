/** Loopback host DSH uses for its own announced Web URL. */
const ANNOUNCED_URL_LINE = /^dsh web:\s*(\S+)/mu

/**
 * Reads the exact URL from DSH's own `dsh web: <url>` startup line.
 *
 * Only a loopback http(s) origin is accepted, so a log line quoting some other
 * address can never redirect the Launcher's runtime view. The query and fragment
 * are preserved because DSH may place a session credential there.
 */
export function parseAnnouncedWebUrl(text: string): string | undefined {
  const matched = ANNOUNCED_URL_LINE.exec(text)
  if (matched === null) return undefined
  const candidate = matched[1]
  if (candidate === undefined) return undefined
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  if (
    parsed.hostname !== '127.0.0.1' &&
    parsed.hostname !== 'localhost' &&
    parsed.hostname !== '[::1]'
  ) {
    return undefined
  }
  return parsed.toString()
}
