#!/usr/bin/env node
// Preflight for two-machine P2P testing.
//
// Checks the two things most likely to block a first run: whether this machine
// has a usable peer helper for its own architecture, and whether the three
// coordination-server endpoints are actually reachable. Every check reports what
// was really observed, so an unreachable server is never reported as "probably
// fine". This tool performs no pairing, sends no credentials and changes no
// state.
import { createHash } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { lstat, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function usage() {
  console.log(`Check whether this machine is ready for two-machine P2P testing.

Usage:
  node tools/p2p-preflight.mjs [--https <url>] [--wss <url>] [--stun <host:port>] [--json]

With no server arguments only the local peer helper is checked. Supplying an
endpoint makes this tool contact it; nothing is sent beyond a plain reachability
probe.
`)
}

function parseArgs(argv) {
  const args = { json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') args.json = true
    else if (arg === '--help' || arg === '-h') args.help = true
    else if (['--https', '--wss', '--stun'].includes(arg)) {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`)
      args[arg.slice(2)] = value
      index += 1
    } else throw new Error(`Unknown argument: ${arg}`)
  }
  return args
}

/** Mirrors the main process resolution so a pass here means the app will accept it. */
async function checkHelper() {
  const platform = process.platform
  const arch = process.arch
  if (!['darwin', 'win32'].includes(platform) || !['arm64', 'x64'].includes(arch))
    return {
      name: 'peer-helper',
      ok: false,
      detail: `Unsupported platform/arch: ${platform}/${arch}. The app supports macOS and Windows on arm64 or x64.`
    }
  const target = `${platform}-${arch}`
  const directory = path.join(appRoot, 'build', 'p2p', target)
  const file = platform === 'win32' ? 'dshker-peer.exe' : 'dshker-peer'
  const executable = path.join(directory, file)
  const buildHint = `Run: node tools/build-peer-helper.mjs --platform ${platform} --arch ${arch === 'x64' ? 'x64' : 'arm64'}`

  let info
  try {
    info = await lstat(executable)
  } catch {
    return {
      name: 'peer-helper',
      ok: false,
      detail: `No helper for this machine at build/p2p/${target}/${file}. A helper built on another machine cannot be copied here. ${buildHint}`
    }
  }
  if (!info.isFile() || info.isSymbolicLink())
    return {
      name: 'peer-helper',
      ok: false,
      detail: `build/p2p/${target}/${file} is not a regular file. Remove it and rebuild. ${buildHint}`
    }

  let manifest
  try {
    manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'))
  } catch {
    return {
      name: 'peer-helper',
      ok: false,
      detail: `manifest.json is missing or unreadable in build/p2p/${target}. ${buildHint}`
    }
  }
  const digest = createHash('sha256')
    .update(await readFile(executable))
    .digest('hex')
  if (manifest.version !== 1 || manifest.target !== target || manifest.file !== file)
    return {
      name: 'peer-helper',
      ok: false,
      detail: `manifest describes ${manifest.target ?? 'an unknown target'}, but this machine needs ${target}. ${buildHint}`
    }
  if (manifest.sha256 !== digest)
    return {
      name: 'peer-helper',
      ok: false,
      detail: `Helper checksum does not match its manifest, so the app will refuse it. ${buildHint}`
    }
  return {
    name: 'peer-helper',
    ok: true,
    detail: `Verified ${target} helper with matching checksum.`
  }
}

/**
 * Probes the HTTPS origin.
 *
 * Certificate rejection is reported distinctly, because the app deliberately
 * refuses a server it cannot verify: that is a server-side fix, not a bug here.
 */
async function checkHttps(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    return { name: 'https', ok: false, detail: `Not a valid URL: ${value}` }
  }
  if (url.protocol !== 'https:')
    return {
      name: 'https',
      ok: false,
      detail: `Must be https:. Plain http is refused by the app.`
    }
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000)
    })
    return {
      name: 'https',
      ok: true,
      detail: `Reachable with a trusted certificate (HTTP ${response.status}). A status other than 200 is fine here; this only proves TLS and reachability.`
    }
  } catch (error) {
    const message = String(error?.cause?.code ?? error?.message ?? error)
    if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ALT_NAME|DEPTH_ZERO/i.test(message))
      return {
        name: 'https',
        ok: false,
        detail: `TLS certificate is not trusted (${message}). The app refuses servers it cannot verify; install a certificate trusted by this machine.`
      }
    return { name: 'https', ok: false, detail: `Unreachable: ${message}` }
  }
}

/** Probes the signalling endpoint by completing a real WebSocket handshake. */
async function checkWss(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    return { name: 'wss', ok: false, detail: `Not a valid URL: ${value}` }
  }
  if (url.protocol !== 'wss:')
    return { name: 'wss', ok: false, detail: `Must be wss:. Plain ws is refused by the app.` }
  if (typeof WebSocket !== 'function')
    return {
      name: 'wss',
      ok: false,
      detail: `This Node build has no global WebSocket; use Node 22+ to run this check.`
    }
  return await new Promise((resolve) => {
    let socket
    const timer = setTimeout(() => {
      try {
        socket?.close()
      } catch {
        // Closing a socket that never opened is not an error worth reporting.
      }
      resolve({
        name: 'wss',
        ok: false,
        detail: `No handshake response within 10s. Check the signalling path and any proxy in front of it.`
      })
    }, 10_000)
    try {
      socket = new WebSocket(url)
    } catch (error) {
      clearTimeout(timer)
      resolve({ name: 'wss', ok: false, detail: `Rejected: ${String(error?.message ?? error)}` })
      return
    }
    socket.onopen = () => {
      clearTimeout(timer)
      socket.close()
      resolve({
        name: 'wss',
        ok: true,
        detail: `WebSocket handshake completed. Signalling transport is reachable.`
      })
    }
    socket.onerror = () => {
      clearTimeout(timer)
      resolve({
        name: 'wss',
        ok: false,
        detail: `Handshake failed. Verify the URL path, TLS trust, and that the server accepts this endpoint.`
      })
    }
  })
}

/**
 * Sends a real STUN Binding request over UDP.
 *
 * This is the check most worth running: a direct connection needs UDP, and a
 * blocked UDP path is the single most common reason pairing succeeds but
 * connecting reports direct_unavailable.
 */
async function checkStun(value) {
  const match = /^\[?([^\]]+)\]?:(\d+)$/.exec(value)
  if (!match) return { name: 'stun', ok: false, detail: `Expected host:port, received: ${value}` }
  const host = match[1]
  const port = Number(match[2])
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    return { name: 'stun', ok: false, detail: `Invalid port: ${match[2]}` }

  // RFC 5389 Binding request: type 0x0001, zero length, fixed magic cookie.
  const request = Buffer.alloc(20)
  request.writeUInt16BE(0x0001, 0)
  request.writeUInt16BE(0, 2)
  request.writeUInt32BE(0x2112a442, 4)
  const transaction = createHash('sha256').update(String(Date.now())).digest().subarray(0, 12)
  transaction.copy(request, 8)

  return await new Promise((resolve) => {
    const socket = createSocket('udp4')
    const finish = (result) => {
      clearTimeout(timer)
      try {
        socket.close()
      } catch {
        // Already closed; the result is what matters.
      }
      resolve(result)
    }
    const timer = setTimeout(
      () =>
        finish({
          name: 'stun',
          ok: false,
          detail: `No STUN response from ${host}:${port} within 8s. UDP is likely blocked on this network or the port is not open. Direct connections cannot work without a UDP path; the relayed fallback also rides UDP to your server, so check its TURN reachability.`
        }),
      8_000
    )
    socket.on('error', (error) =>
      finish({ name: 'stun', ok: false, detail: `UDP error: ${error.message}` })
    )
    socket.on('message', (message) => {
      if (message.length < 20 || message.readUInt32BE(4) !== 0x2112a442) {
        finish({
          name: 'stun',
          ok: false,
          detail: `Received a reply that is not a STUN message; something else is answering on this port.`
        })
        return
      }
      if (!message.subarray(8, 20).equals(transaction)) {
        finish({
          name: 'stun',
          ok: false,
          detail: `STUN reply did not match the request transaction; ignoring it as unrelated traffic.`
        })
        return
      }
      finish({
        name: 'stun',
        ok: true,
        detail: `STUN Binding succeeded, so a UDP path to ${host}:${port} exists. This does not by itself prove the two peers can reach each other.`
      })
    })
    socket.send(request, port, host, (error) => {
      if (error) finish({ name: 'stun', ok: false, detail: `Send failed: ${error.message}` })
    })
  })
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  usage()
  process.exit(0)
}

const checks = [await checkHelper()]
if (args.https) checks.push(await checkHttps(args.https))
if (args.wss) checks.push(await checkWss(args.wss))
if (args.stun) checks.push(await checkStun(args.stun))

const serverChecked = Boolean(args.https || args.wss || args.stun)
const ok = checks.every((check) => check.ok)

if (args.json) {
  console.log(
    JSON.stringify({ ok, platform: process.platform, arch: process.arch, checks }, null, 2)
  )
} else {
  console.log(`P2P preflight on ${process.platform}/${process.arch}\n`)
  for (const check of checks)
    console.log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.name}\n      ${check.detail}\n`)
  if (!serverChecked)
    console.log(
      'Only the local helper was checked. Pass --https, --wss and --stun to verify your coordination server.\n'
    )
  if (!ok) console.log('Resolve the failures above before starting two-machine testing.\n')
}

process.exit(ok ? 0 : 1)
