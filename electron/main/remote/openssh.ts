import { spawn, type ChildProcess } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises'
import { request } from 'node:http'
import { connect as connectTcp, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { RemoteComputerView } from '../../../src/shared/contracts'
import { terminateManagedProcessTree } from '../managed/process-tree'
import {
  REMOTE_PEER_DESCRIPTOR_RELATIVE_PATH,
  REMOTE_PEER_PROTOCOL_VERSION,
  parseRemotePeerDescriptor
} from './peer-broker'
import { RemoteConnectionError } from './errors'

const PROCESS_READY_TIMEOUT_MS = 10_000
const PEER_REQUEST_TIMEOUT_MS = 70_000

export interface OpenSshExecutableSet {
  readonly ssh: string
  readonly scp: string
}

export interface RemoteTunnel {
  readonly url: string
  stop(): Promise<void>
}

export interface OpenSshRemoteConnectorOptions {
  readonly platform: NodeJS.Platform
  readonly executables?: OpenSshExecutableSet
}

/** Owns descriptor transfer plus broker and DSH port forwards for one remote generation. */
export class OpenSshRemoteConnector {
  readonly #platform: NodeJS.Platform
  readonly #executables: OpenSshExecutableSet

  constructor(options: OpenSshRemoteConnectorOptions) {
    this.#platform = options.platform
    this.#executables = options.executables ?? resolveOpenSshExecutables(options.platform)
  }

  async connect(
    computer: RemoteComputerView,
    onExit: () => void,
    signal?: AbortSignal
  ): Promise<RemoteTunnel> {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'dshker-peer-'))
    await chmod(temporaryDirectory, 0o700)
    const descriptorPath = path.join(temporaryDirectory, 'remote-peer.json')
    let brokerProcess: ChildProcess | undefined
    let runtimeProcess: ChildProcess | undefined
    let settled = false
    const unexpectedExit = (): void => {
      if (!settled) onExit()
    }
    const abort = (): void => {
      settled = true
      void Promise.all([
        stopProcess(brokerProcess, this.#platform),
        stopProcess(runtimeProcess, this.#platform)
      ])
    }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      assertNotAborted(signal)
      await runScp(this.#executables.scp, buildScpArguments(computer, descriptorPath), signal)
      const descriptor = parseRemotePeerDescriptor(await readFile(descriptorPath, 'utf8'))

      const brokerLocalPort = await reserveLoopbackPort()
      brokerProcess = spawnTunnel(
        this.#executables.ssh,
        buildSshForwardArguments(computer, brokerLocalPort, descriptor.port),
        this.#platform
      )
      await waitForForward(brokerProcess, brokerLocalPort)
      assertNotAborted(signal)

      const remoteUrl = await requestRemoteRuntime(brokerLocalPort, descriptor.secret)
      assertNotAborted(signal)
      const remote = parseRemoteRuntimeUrl(remoteUrl)
      const runtimeLocalPort = await reserveLoopbackPort()
      runtimeProcess = spawnTunnel(
        this.#executables.ssh,
        buildSshForwardArguments(computer, runtimeLocalPort, remote.port),
        this.#platform
      )
      await waitForForward(runtimeProcess, runtimeLocalPort)
      assertNotAborted(signal)

      brokerProcess.once('exit', unexpectedExit)
      runtimeProcess.once('exit', unexpectedExit)
      const mapped = new URL(remote.url.toString())
      mapped.hostname = '127.0.0.1'
      mapped.port = String(runtimeLocalPort)
      return {
        url: mapped.toString(),
        stop: async () => {
          settled = true
          await Promise.all([
            stopProcess(brokerProcess, this.#platform),
            stopProcess(runtimeProcess, this.#platform)
          ])
        }
      }
    } catch (error) {
      settled = true
      await Promise.all([
        stopProcess(brokerProcess, this.#platform),
        stopProcess(runtimeProcess, this.#platform)
      ])
      if (error instanceof RemoteConnectionError) throw error
      throw new RemoteConnectionError('remote.tunnel_failed', 'SSH tunnel setup failed.', {
        cause: error
      })
    } finally {
      signal?.removeEventListener('abort', abort)
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  }
}

export function resolveOpenSshExecutables(platform: NodeJS.Platform): OpenSshExecutableSet {
  if (platform === 'darwin') return { ssh: '/usr/bin/ssh', scp: '/usr/bin/scp' }
  if (platform === 'win32') return { ssh: 'ssh.exe', scp: 'scp.exe' }
  return { ssh: '/usr/bin/ssh', scp: '/usr/bin/scp' }
}

export function buildScpArguments(
  computer: RemoteComputerView,
  destinationPath: string
): readonly string[] {
  return [
    '-q',
    '-B',
    '-o',
    'StrictHostKeyChecking=yes',
    '-P',
    String(computer.port),
    `${computer.user}@${computer.host}:${REMOTE_PEER_DESCRIPTOR_RELATIVE_PATH}`,
    destinationPath
  ]
}

export function buildSshForwardArguments(
  computer: RemoteComputerView,
  localPort: number,
  remotePort: number
): readonly string[] {
  return [
    '-N',
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-p',
    String(computer.port),
    '-L',
    `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
    `${computer.user}@${computer.host}`
  ]
}

export function parseRemoteRuntimeUrl(value: string): { readonly url: URL; readonly port: number } {
  let url: URL
  try {
    url = new URL(value)
  } catch (error) {
    throw new RemoteConnectionError(
      'remote.peer_protocol_invalid',
      'Remote DSH URL is malformed.',
      { cause: error }
    )
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    !isLoopbackHost(url.hostname) ||
    url.port.length === 0
  ) {
    throw new RemoteConnectionError(
      'remote.peer_protocol_invalid',
      'Remote DSH URL is not an explicit loopback address.'
    )
  }
  const port = Number(url.port)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new RemoteConnectionError(
      'remote.peer_protocol_invalid',
      'Remote DSH URL port is invalid.'
    )
  }
  return { url, port }
}

async function runScp(
  executable: string,
  args: readonly string[],
  signal?: AbortSignal
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      signal
    })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 4_096) stderr += chunk.toString('utf8')
    })
    child.once('error', (error) => {
      reject(
        new RemoteConnectionError(
          'remote.ssh_unavailable',
          'OpenSSH file transfer is unavailable.',
          { cause: error }
        )
      )
    })
    child.once('exit', (code) => {
      if (code === 0) resolve()
      else if (
        /permission denied|authentication failed|host key verification failed/iu.test(stderr)
      ) {
        reject(
          new RemoteConnectionError(
            'remote.ssh_authentication_failed',
            'SSH authentication or host verification failed.'
          )
        )
      } else {
        reject(
          new RemoteConnectionError(
            'remote.peer_unavailable',
            'Remote DSHKer peer descriptor is unavailable.'
          )
        )
      }
    })
  })
}

function spawnTunnel(
  executable: string,
  args: readonly string[],
  platform: NodeJS.Platform
): ChildProcess {
  return spawn(executable, args, {
    detached: platform !== 'win32',
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true
  })
}

async function waitForForward(child: ChildProcess, port: number): Promise<void> {
  const deadline = Date.now() + PROCESS_READY_TIMEOUT_MS
  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    if (stderr.length < 4_096) stderr += chunk.toString('utf8')
  })
  await new Promise<void>((resolve, reject) => {
    let finished = false
    const complete = (error?: Error): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      child.removeListener('error', onError)
      child.removeListener('exit', onExit)
      error === undefined ? resolve() : reject(error)
    }
    const probe = (): void => {
      if (finished) return
      const socket = connectTcp({ host: '127.0.0.1', port })
      socket.once('connect', () => {
        socket.destroy()
        complete()
      })
      socket.once('error', () => {
        socket.destroy()
        if (Date.now() < deadline) setTimeout(probe, 50)
      })
    }
    const onError = (error: Error): void =>
      complete(
        new RemoteConnectionError(
          'remote.ssh_unavailable',
          'OpenSSH tunnel executable is unavailable.',
          { cause: error }
        )
      )
    const onExit = (): void => complete(classifySshFailure(stderr, 'SSH port forwarding failed.'))
    child.once('error', onError)
    child.once('exit', onExit)
    const timer = setTimeout(
      () =>
        complete(
          new RemoteConnectionError(
            'remote.tunnel_failed',
            'SSH port forwarding did not become ready.'
          )
        ),
      PROCESS_READY_TIMEOUT_MS
    )
    probe()
  })
}

async function requestRemoteRuntime(port: number, secret: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const operation = request(
      {
        host: '127.0.0.1',
        port,
        path: '/v1/runtime/connect',
        method: 'POST',
        headers: { authorization: `Bearer ${secret}`, 'content-length': '0' },
        timeout: PEER_REQUEST_TIMEOUT_MS
      },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => {
          if (body.length < 16_384) body += chunk
        })
        response.on('end', () => {
          if (response.statusCode === 401) {
            reject(
              new RemoteConnectionError(
                'remote.peer_authentication_failed',
                'Remote DSHKer rejected peer authentication.'
              )
            )
            return
          }
          if (response.statusCode !== 200) {
            reject(
              new RemoteConnectionError(
                'remote.peer_unavailable',
                'Remote DSHKer could not provide a DSH session.'
              )
            )
            return
          }
          try {
            const value = JSON.parse(body) as unknown
            if (value === null || typeof value !== 'object' || Array.isArray(value))
              throw new Error('invalid response')
            const record = value as Record<string, unknown>
            const keys = Object.keys(record)
            if (
              keys.length !== 2 ||
              !keys.includes('version') ||
              !keys.includes('url') ||
              record.version !== REMOTE_PEER_PROTOCOL_VERSION ||
              typeof record.url !== 'string'
            )
              throw new Error('invalid response')
            resolve(record.url)
          } catch (error) {
            reject(
              new RemoteConnectionError(
                'remote.peer_protocol_invalid',
                'Remote DSHKer response is invalid.',
                { cause: error }
              )
            )
          }
        })
      }
    )
    operation.once('timeout', () => operation.destroy(new Error('peer request timed out')))
    operation.once('error', (error) =>
      reject(
        new RemoteConnectionError(
          'remote.peer_unavailable',
          'Remote DSHKer peer endpoint is unavailable.',
          { cause: error }
        )
      )
    )
    operation.end()
  })
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer()
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string')
        reject(new Error('No TCP port was reserved.'))
      else resolve(address.port)
    })
  })
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )
  return port
}

async function stopProcess(
  child: ChildProcess | undefined,
  platform: NodeJS.Platform
): Promise<void> {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return
  try {
    terminateManagedProcessTree(child.pid, platform)
  } catch {
    child.kill('SIGTERM')
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 3_000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

function classifySshFailure(stderr: string, message: string): RemoteConnectionError {
  if (/permission denied|authentication failed|host key verification failed/iu.test(stderr)) {
    return new RemoteConnectionError(
      'remote.ssh_authentication_failed',
      'SSH authentication or host verification failed.'
    )
  }
  return new RemoteConnectionError('remote.tunnel_failed', message)
}

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === '127.0.0.1' ||
    hostname === 'localhost' ||
    hostname === '[::1]' ||
    hostname === '::1'
  )
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new RemoteConnectionError('remote.tunnel_failed', 'Remote connection was cancelled.')
  }
}
