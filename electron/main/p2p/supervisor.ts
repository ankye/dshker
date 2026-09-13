// The shell no longer launches a peer helper: the core it already runs answers
// the peer table (task 3.7), so the peer supervisor was deleted rather than left
// dormant. What remains here is what the core's own supervisor needs — waiting
// for a child to exit with escalation, and verifying a packaged binary against
// its manifest.
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { exactPeerObject, parsePeerJson, PeerHelperError } from './wire'

export async function stopChild(
  child: ChildProcessWithoutNullStreams,
  exit: Promise<void>
): Promise<void> {
  if (await exitedWithin(exit, 10_000)) return
  child.kill('SIGTERM')
  if (await exitedWithin(exit, 5_000)) return
  child.kill('SIGKILL')
  if (!(await exitedWithin(exit, 5_000))) throw new PeerHelperError('p2p.helper_shutdown_failed')
}

export function exitedWithin(exit: Promise<void>, milliseconds: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), milliseconds)
    void exit.then(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

// The packaged helper directory still holds two executables and two manifests —
// dshker-peer (manifest.json, frozen schema) and dshkerd (dshkerd-manifest.json) —
// because the peer binary stays packaged until P6 deletes it. Only dshkerd is
// started now. Both runtime-verify their own bytes.
export async function verifyHelperResource(
  root: string,
  name: 'dshker-peer' | 'dshkerd'
): Promise<string> {
  if (name !== 'dshker-peer' && name !== 'dshkerd')
    throw new PeerHelperError('p2p.invalid_arguments')
  if (
    !isAbsolute(root) ||
    !['darwin', 'linux', 'win32'].includes(process.platform) ||
    !['arm64', 'x64'].includes(process.arch)
  )
    throw new PeerHelperError('p2p.helper_platform_unsupported')
  const target = `${process.platform}-${process.arch}`
  const directory = join(root, 'p2p', target)
  const fileName = process.platform === 'win32' ? name + '.exe' : name
  const executable = join(directory, fileName)
  const manifestFile = name === 'dshkerd' ? 'dshkerd-manifest.json' : 'manifest.json'
  try {
    const info = await lstat(executable)
    if (!info.isFile() || info.isSymbolicLink()) throw new PeerHelperError('p2p.helper_invalid')
    const manifest = exactPeerObject(
      parsePeerJson(await readFile(join(directory, manifestFile), 'utf8')),
      ['version', 'target', 'file', 'sha256']
    )
    const digest = createHash('sha256')
      .update(await readFile(executable))
      .digest('hex')
    if (
      manifest.version !== 1 ||
      manifest.target !== target ||
      manifest.file !== fileName ||
      manifest.sha256 !== digest
    )
      throw new PeerHelperError('p2p.helper_integrity_failed')
  } catch (error) {
    if (error instanceof PeerHelperError) throw error
    throw new PeerHelperError('p2p.helper_resource_unavailable')
  }
  return executable
}
