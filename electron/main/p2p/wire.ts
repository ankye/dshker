/** Private main/helper framing. Never exported through the renderer preload. */
export const MAX_PEER_CONTROL_BYTES = 64 * 1024

export class PeerHelperError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'PeerHelperError'
  }
}

export interface PeerFrame {
  version: 1
  id: number
  method: string
  payload: unknown
  error: string
}

/** Reject ambiguity before JSON.parse can erase duplicate object keys. */
export function parsePeerJson(text: string): unknown {
  if (Buffer.byteLength(text) > MAX_PEER_CONTROL_BYTES) fail()
  let offset = 0
  const whitespace = () => {
    while (/[\x20\t\r\n]/.test(text[offset] ?? '\0')) offset++
  }
  const string = (): string => {
    whitespace()
    const match = /^"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/.exec(
      text.slice(offset)
    )
    if (!match) return fail()
    offset += match[0].length
    return JSON.parse(match[0]) as string
  }
  const value = (depth: number): void => {
    if (depth > 12) fail()
    whitespace()
    const char = text[offset]
    if (char === '"') {
      string()
      return
    }
    if (char === '{' || char === '[') {
      const close = char === '{' ? '}' : ']'
      const keys = new Set<string>()
      offset++
      whitespace()
      if (text[offset] !== close) {
        while (true) {
          if (char === '{') {
            const key = string()
            if (keys.has(key)) fail()
            keys.add(key)
            whitespace()
            if (text[offset++] !== ':') fail()
          }
          value(depth + 1)
          whitespace()
          if (text[offset] !== ',') break
          offset++
        }
      }
      if (text[offset++] !== close) fail()
      return
    }
    const atom = /^(?:true|false|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
      text.slice(offset)
    )
    if (!atom) fail()
    if (atom[0] !== 'true' && atom[0] !== 'false' && !Number.isFinite(Number(atom[0]))) fail()
    offset += atom[0].length
  }
  value(0)
  whitespace()
  if (offset !== text.length) fail()
  return JSON.parse(text) as unknown
}

export function exactPeerObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail()
  const record = value as Record<string, unknown>
  if (
    Object.keys(record).length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(record, key))
  )
    return fail()
  return record
}

export function peerErrorCode(value: unknown): value is string {
  return typeof value === 'string' && /^p2p\.[a-z_.]{1,92}$/.test(value)
}

export function decodePeerFrame(text: string): PeerFrame {
  const frame = exactPeerObject(parsePeerJson(text), [
    'version',
    'id',
    'method',
    'payload',
    'error'
  ])
  if (
    frame.version !== 1 ||
    typeof frame.id !== 'number' ||
    !Number.isSafeInteger(frame.id) ||
    frame.id <= 0 ||
    typeof frame.method !== 'string' ||
    frame.method.length > 80 ||
    typeof frame.error !== 'string' ||
    (frame.error !== '' && !peerErrorCode(frame.error)) ||
    (frame.method !== '' && frame.error !== '')
  )
    return fail()
  return frame as unknown as PeerFrame
}

function fail(): never {
  throw new PeerHelperError('p2p.protocol_mismatch')
}
