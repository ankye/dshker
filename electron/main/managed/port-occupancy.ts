import { ManagedHarnessRuntimeError } from './runtime-errors'
import { runText } from './process-utils'

/** One process listening on a specific port, with the command line we could read. */
export interface PortOccupant {
  readonly pid: number
  readonly commandLine: string | undefined
}

/** A bounded command runner kept as a test seam. */
export type PortCommandRunner = (
  executable: string,
  arguments_: readonly string[]
) => Promise<string>

/** Reads the process listening on a port, or undefined when nothing is. */
export async function findPortOccupant(
  port: number,
  platform: NodeJS.Platform,
  run: PortCommandRunner = runText
): Promise<PortOccupant | undefined> {
  if (platform === 'win32') return findWindowsPortOccupant(port, run)
  return findPosixPortOccupant(port, run)
}

async function findPosixPortOccupant(
  port: number,
  run: PortCommandRunner
): Promise<PortOccupant | undefined> {
  let listing: string
  try {
    listing = await run('lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN'])
  } catch {
    // lsof exits non-zero when nothing listens; that is the free case.
    return undefined
  }
  const pid = parseLsofListenPid(listing)
  if (pid === undefined) return undefined
  let commandLine: string | undefined
  try {
    commandLine = (await run('ps', ['-p', String(pid), '-o', 'command='])).trim()
  } catch {
    commandLine = undefined
  }
  if (commandLine === '') commandLine = undefined
  return { pid, commandLine }
}

async function findWindowsPortOccupant(
  port: number,
  run: PortCommandRunner
): Promise<PortOccupant | undefined> {
  let netstat: string
  try {
    netstat = await run('netstat', ['-ano'])
  } catch {
    return undefined
  }
  const pid = parseNetstatListenPid(netstat, port)
  if (pid === undefined) return undefined
  let commandLine: string | undefined
  try {
    commandLine = (
      await run('wmic', [
        'process',
        'where',
        'processid=' + pid,
        'get',
        'commandline',
        '/format:list'
      ])
    ).trim()
  } catch {
    commandLine = undefined
  }
  if (commandLine === '') commandLine = undefined
  return { pid, commandLine }
}

/** Parses the LISTEN line of `lsof -nP -iTCP:<port> -sTCP:LISTEN`. */
export function parseLsofListenPid(listing: string): number | undefined {
  for (const line of listing.split('\n')) {
    if (line.startsWith('COMMAND')) continue
    const fields = line.trim().split(/\s+/u)
    if (fields.length < 2 || !/^[0-9]+$/u.test(fields[1] ?? '')) continue
    const pid = Number(fields[1])
    if (Number.isSafeInteger(pid) && pid > 0) return pid
  }
  return undefined
}

/** Parses the LISTENING pid of `netstat -ano` for one port. */
export function parseNetstatListenPid(netstat: string, port: number): number | undefined {
  const suffix = ':' + port
  for (const line of netstat.split('\n')) {
    if (!/LISTENING/u.test(line)) continue
    if (!line.includes(suffix)) continue
    const pidToken = line.trim().split(/\s+/u).at(-1)
    if (pidToken === undefined || !/^[0-9]+$/u.test(pidToken)) continue
    const pid = Number(pidToken)
    if (Number.isSafeInteger(pid) && pid > 0) return pid
  }
  return undefined
}

/**
 * Recognizes a DSH Web process, so the Launcher can adopt a leftover instance
 * of itself instead of refusing to start forever.
 */
export function isResidualDshWebCommand(commandLine: string | undefined): boolean {
  if (commandLine === undefined) return false
  return /\bdsh web\b/u.test(commandLine) || /\bbin\.(?:j|t)s web\b/u.test(commandLine)
}

/** Signals a leftover DSH tree and waits for it to actually disappear. */
export async function terminatePortOccupant(
  pid: number,
  deps: Readonly<{
    killProcess: (target: number, signal: NodeJS.Signals) => boolean
    isAlive: (target: number) => boolean
    waitMillis: (milliseconds: number) => Promise<void>
  }> = {
    killProcess: process.kill.bind(process),
    isAlive: (target) => {
      try {
        process.kill(target, 0)
        return true
      } catch {
        return false
      }
    },
    waitMillis: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  }
): Promise<void> {
  try {
    deps.killProcess(pid, 'SIGTERM')
  } catch {
    return
  }
  const deadline = Date.now() + 2_500
  while (Date.now() < deadline) {
    await deps.waitMillis(120)
    if (!deps.isAlive(pid)) return
  }
  try {
    deps.killProcess(pid, 'SIGKILL')
  } catch {
    return
  }
  await deps.waitMillis(120)
}

/** Result of preparing one fixed port before a launch. */
export type PortLaunchDecision =
  | { readonly kind: 'free' }
  | { readonly kind: 'cleared'; readonly pid: number }
  | { readonly kind: 'foreign'; readonly occupant: PortOccupant }

/**
 * Checks one launch port and decides whether to proceed.
 *
 * A leftover DSH Web process is adopted: the Launcher stops the instance it
 * implicitly owns before starting another. Any other holder is a refusal the
 * renderer must explain, not a launch failure.
 */
export async function preparePortForLaunch(
  port: number,
  deps: Readonly<{
    findOccupant: (port: number) => Promise<PortOccupant | undefined>
    isResidual: (commandLine: string | undefined) => boolean
    terminate: (pid: number) => Promise<void>
  }> = {
    findOccupant: (target) => findPortOccupant(target, process.platform),
    isResidual: isResidualDshWebCommand,
    terminate: (pid) => terminatePortOccupant(pid)
  }
): Promise<PortLaunchDecision> {
  const occupant = await deps.findOccupant(port)
  if (occupant === undefined) return { kind: 'free' }
  if (deps.isResidual(occupant.commandLine)) {
    await deps.terminate(occupant.pid)
    return { kind: 'cleared', pid: occupant.pid }
  }
  return { kind: 'foreign', occupant }
}

/** Builds the typed failure a foreign port holder should surface as. */
export function foreignPortFailure(
  port: number,
  occupant: PortOccupant
): ManagedHarnessRuntimeError {
  const label =
    occupant.commandLine === undefined
      ? 'pid ' + occupant.pid
      : 'pid ' + occupant.pid + ' (' + occupant.commandLine.slice(0, 80) + ')'
  return new ManagedHarnessRuntimeError(
    'runtime.port_in_use',
    'Port ' + port + ' is already in use by another process: ' + label + '. Stop it and retry.'
  )
}
