import { chmod, lstat, mkdtemp, rmdir, unlink } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PeerHelperError } from './wire'

export function peerPipeName(nonce: string): string {
  if (!/^[a-f0-9]{32}$/.test(nonce)) throw new PeerHelperError('p2p.invalid_socket')
  return `\\\\.\\pipe\\dshker-peer-${nonce}`
}

/** Returned directory is owned solely by this helper launch, never user-selected. */
export async function createPeerChannel(): Promise<{ path: string; directory?: string }> {
  if (process.platform === 'win32') return { path: peerPipeName(randomBytes(16).toString('hex')) }
  // macOS and Linux both use an exclusive Unix-socket directory owned by the
  // helper launch. Linux is a first-class platform, never a skip target.
  if (process.platform !== 'darwin' && process.platform !== 'linux')
    throw new PeerHelperError('p2p.helper_platform_unsupported')
  const directory = await mkdtemp(join(tmpdir(), 'dp-'))
  try {
    await chmod(directory, 0o700)
    return { directory, path: join(directory, 'peer.sock') }
  } catch {
    await rmdir(directory)
    throw new PeerHelperError('p2p.insecure_socket_directory')
  }
}

/** Call only after the owning child has exited. Never recursively remove contents. */
export async function removePeerChannel(directory: string): Promise<void> {
  try {
    const parent = await lstat(directory)
    if (!parent.isDirectory() || parent.isSymbolicLink())
      throw new PeerHelperError('p2p.helper_cleanup_failed')
    const path = join(directory, 'peer.sock')
    const socket = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined // Child normally unlinks its own socket.
      throw error
    })
    if (socket && (!socket.isSocket() || socket.isSymbolicLink()))
      throw new PeerHelperError('p2p.helper_cleanup_failed')
    if (socket) await unlink(path)
    await rmdir(directory)
  } catch {
    throw new PeerHelperError('p2p.helper_cleanup_failed')
  }
}
