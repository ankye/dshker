import type { Socket } from 'node:net'
import {
  decodePeerFrame,
  MAX_PEER_CONTROL_BYTES,
  peerErrorCode,
  PeerHelperError,
  type PeerFrame
} from './wire'

export type PeerMainMethod = 'runtime.connect' | 'peer.state'
export type PeerMainHandler = (
  method: PeerMainMethod,
  payload: unknown,
  signal: AbortSignal
) => Promise<unknown>

interface Pending {
  resolve(value: unknown): void
  reject(error: PeerHelperError): void
  cleanup(): void
}

/** One authenticated Unix socket/named pipe, owned only by Electron main. */
export class PeerRpc {
  readonly #socket: Socket
  readonly #handler: PeerMainHandler
  readonly #pending = new Map<number, Pending>()
  readonly #incoming = new Set<AbortController>()
  readonly #onClose: (error: PeerHelperError) => void
  #buffer: Buffer = Buffer.alloc(0)
  #next = 0
  #lastIncoming = 0
  #closed = false

  constructor(socket: Socket, handler: PeerMainHandler, onClose: (error: PeerHelperError) => void) {
    this.#socket = socket
    this.#handler = handler
    this.#onClose = onClose
    socket.on('data', (data: Buffer) => this.#receive(data))
    socket.on('error', () => this.close())
    socket.on('close', () => this.close())
    socket.on('end', () => this.close())
  }

  call(method: string, payload: unknown, signal: AbortSignal): Promise<unknown> {
    if (this.#closed) return Promise.reject(new PeerHelperError('p2p.helper_unavailable'))
    if (signal.aborted) return Promise.reject(new PeerHelperError('p2p.request_cancelled'))
    if (!method || method.length > 80)
      return Promise.reject(new PeerHelperError('p2p.invalid_operation'))
    if (this.#pending.size >= 16 || this.#next >= Number.MAX_SAFE_INTEGER)
      return Promise.reject(new PeerHelperError('p2p.helper_busy'))
    const id = ++this.#next
    return new Promise((resolve, reject) => {
      const finish = (code: string) => {
        this.#pending.delete(id)
        cleanup()
        reject(new PeerHelperError(code))
      }
      const abort = () => finish('p2p.request_cancelled')
      const timer = setTimeout(() => finish('p2p.request_timeout'), 90_000)
      const cleanup = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
      }
      this.#pending.set(id, { resolve, reject, cleanup })
      signal.addEventListener('abort', abort, { once: true })
      try {
        this.#write({ version: 1, id, method, payload, error: '' })
      } catch (error) {
        finish(error instanceof PeerHelperError ? error.code : 'p2p.invalid_payload')
      }
    })
  }

  close(error = new PeerHelperError('p2p.helper_unavailable')): void {
    if (this.#closed) return
    this.#closed = true
    this.#buffer.fill(0)
    this.#buffer = Buffer.alloc(0)
    this.#socket.destroy()
    for (const pending of this.#pending.values()) {
      pending.cleanup()
      pending.reject(error)
    }
    this.#pending.clear()
    for (const controller of this.#incoming) controller.abort()
    this.#onClose(error)
  }

  #receive(data: Buffer): void {
    if (this.#closed) return
    try {
      // Consume lines incrementally; a single OS read may contain many frames.
      let offset = 0
      while (offset < data.length) {
        const newline = data.indexOf(10, offset)
        const end = newline < 0 ? data.length : newline
        if (this.#buffer.length + end - offset > MAX_PEER_CONTROL_BYTES)
          throw new PeerHelperError('p2p.protocol_limit')
        this.#buffer = Buffer.concat([this.#buffer, data.subarray(offset, end)])
        if (newline < 0) break
        const frame = decodePeerFrame(
          new TextDecoder('utf-8', { fatal: true }).decode(this.#buffer)
        )
        this.#buffer.fill(0)
        this.#buffer = Buffer.alloc(0)
        this.#dispatch(frame)
        offset = newline + 1
      }
    } catch {
      this.close(new PeerHelperError('p2p.protocol_mismatch'))
    }
  }

  #dispatch(frame: PeerFrame): void {
    if (frame.method === '') {
      const pending = this.#pending.get(frame.id)
      if (!pending) return // Timed-out responses never become another call's result.
      this.#pending.delete(frame.id)
      pending.cleanup()
      if (frame.error) pending.reject(new PeerHelperError(frame.error))
      else pending.resolve(frame.payload)
      return
    }
    if (frame.id <= this.#lastIncoming) throw new PeerHelperError('p2p.protocol_mismatch')
    this.#lastIncoming = frame.id
    if (frame.method !== 'runtime.connect' && frame.method !== 'peer.state') {
      this.#write({ ...frame, method: '', payload: {}, error: 'p2p.invalid_operation' })
      return
    }
    if (this.#incoming.size >= 16) {
      this.#write({ ...frame, method: '', payload: {}, error: 'p2p.helper_busy' })
      return
    }
    void this.#handle(frame, frame.method).catch(() =>
      this.close(new PeerHelperError('p2p.protocol_mismatch'))
    )
  }

  async #handle(frame: PeerFrame, method: PeerMainMethod): Promise<void> {
    const controller = new AbortController()
    this.#incoming.add(controller)
    const timer = setTimeout(() => controller.abort(), 90_000)
    try {
      const payload = await this.#handler(method, frame.payload, controller.signal)
      if (!this.#closed && !controller.signal.aborted)
        this.#write({ ...frame, method: '', payload, error: '' })
    } catch (error) {
      const code =
        error instanceof PeerHelperError && peerErrorCode(error.code)
          ? error.code
          : 'p2p.operation_failed'
      if (!this.#closed) this.#write({ ...frame, method: '', payload: {}, error: code })
    } finally {
      clearTimeout(timer)
      this.#incoming.delete(controller)
    }
  }

  #write(frame: PeerFrame): void {
    if (this.#closed) throw new PeerHelperError('p2p.helper_unavailable')
    const encoded = JSON.stringify(frame)
    // Also validate outbound values: undefined/NaN/null must not be silently coerced.
    decodePeerFrame(encoded)
    if (this.#socket.writableLength + Buffer.byteLength(encoded) > 1024 * 1024) {
      this.close(new PeerHelperError('p2p.protocol_limit'))
      throw new PeerHelperError('p2p.protocol_limit')
    }
    this.#socket.write(encoded + '\n')
  }
}
