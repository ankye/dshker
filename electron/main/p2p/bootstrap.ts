import type { Readable } from 'node:stream'
import { connect, type Socket } from 'node:net'
import { exactPeerObject, MAX_PEER_CONTROL_BYTES, parsePeerJson, PeerHelperError } from './wire'

/** Reads one bounded handshake line, retaining any subsequent socket bytes. */
export function readPeerLine(stream: Readable, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffer: Buffer = Buffer.alloc(0)
    const cleanup = () => {
      stream.off('data', data)
      stream.off('error', unavailable)
      stream.off('end', unavailable)
      stream.off('close', unavailable)
      signal.removeEventListener('abort', unavailable)
    }
    const unavailable = () => {
      cleanup()
      buffer.fill(0)
      reject(new PeerHelperError('p2p.helper_parent_unavailable'))
    }
    const data = (chunk: Buffer) => {
      const newline = chunk.indexOf(10)
      const end = newline < 0 ? chunk.length : newline
      if (buffer.length + end > MAX_PEER_CONTROL_BYTES) return unavailable()
      buffer = Buffer.concat([buffer, chunk.subarray(0, end)])
      if (newline < 0) return
      stream.pause()
      cleanup()
      if (newline + 1 < chunk.length) stream.unshift(chunk.subarray(newline + 1))
      try {
        resolve(parsePeerJson(new TextDecoder('utf-8', { fatal: true }).decode(buffer)))
      } catch {
        reject(new PeerHelperError('p2p.protocol_mismatch'))
      } finally {
        buffer.fill(0)
      }
    }
    if (signal.aborted) return unavailable()
    signal.addEventListener('abort', unavailable, { once: true })
    stream.on('data', data)
    stream.once('error', unavailable)
    stream.once('end', unavailable)
    stream.once('close', unavailable)
    stream.resume()
  })
}

export async function authenticatePeer(
  path: string,
  secret: string,
  signal: AbortSignal
): Promise<Socket> {
  const socket = connect({ path })
  // Keep an error listener through handoff to PeerRpc, never print raw errors.
  socket.on('error', () => socket.destroy())
  try {
    const response = readPeerLine(socket, signal)
    socket.write(JSON.stringify({ version: 1, secret }) + '\n')
    const ack = exactPeerObject(await response, ['version', 'authenticated'])
    if (ack.version !== 1 || ack.authenticated !== true)
      throw new PeerHelperError('p2p.helper_authentication_failed')
    return socket
  } catch (error) {
    socket.destroy()
    throw error
  }
}
