// Read-only Windows acceptance of the explicitly installed formal candidate.
// No UI inputs, process termination, credential writes or record repair occur here.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import net from 'node:net'
import { extractFile } from '@electron/asar'

const requireValue = (name) => {
  const value = process.env[name]
  if (!value || !path.isAbsolute(value)) throw new Error(`Explicit absolute ${name} required`)
  return value
}
if (process.platform !== 'win32') throw new Error('Native Windows acceptance required')
const formal = requireValue('DSHKER_FORMAL_RUNTIME_ROOT')
const resources = requireValue('DSHKER_FORMAL_APP_RESOURCES')
const evidence = requireValue('DSHKER_FORMAL_RUNTIME_EVIDENCE')
if (!/^[d-f]:/i.test(evidence)) throw new Error('Evidence must remain on the data drive')
const expectedVersion = process.env.DSHKER_EXPECTED_RUNTIME_VERSION
if (!/^\d+\.\d+\.\d+$/.test(expectedVersion ?? ''))
  throw new Error('Explicit expected version required')
const mode = process.argv[2]
if (!['--running', '--after-quit'].includes(mode))
  throw new Error('Explicit readback mode required')
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
const psLiteral = (value) => `'${value.replaceAll("'", "''")}'`
const environment = { ...process.env }
delete environment.PSModulePath
const powershell = (script) =>
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    env: environment,
    timeout: 15_000
  })
powershell(
  `$ErrorActionPreference='Stop'; $a=Get-Acl -LiteralPath ${psLiteral(evidence)}; $s=[Security.Principal.WindowsIdentity]::GetCurrent().User; if($a.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $s.Value){throw 'Private evidence owner required'}; foreach($r in $a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if($r.AccessControlType -eq 'Allow' -and $r.IdentityReference.Value -notin @($s.Value,'S-1-5-18')){throw 'Private evidence ACL required'}}`
)

const packageMetadata = JSON.parse(
  extractFile(path.join(resources, 'app.asar'), 'package.json').toString()
)
if (
  packageMetadata.version !== expectedVersion ||
  packageMetadata.dshkerDistributionChannel !== 'stable'
)
  throw new Error('Installed formal identity mismatch')
const asarHash = digest(fs.readFileSync(path.join(resources, 'app.asar')))
const coreExecutable = path.join(resources, 'p2p/win32-x64/dshkerd.exe')
const coreHash = digest(fs.readFileSync(coreExecutable))
const baseline = json(path.join(evidence, 'backup-receipt.json'))
const identity = (v) => ({
  catalogId: v.catalogId,
  services: v.services.map(({ serviceId, httpsOrigin, wssUrl, stunAddress, publicKey }) => ({
    serviceId,
    httpsOrigin,
    wssUrl,
    stunAddress,
    publicKey
  })),
  computers: v.computers.map(
    ({
      connectionId,
      serviceId,
      pairId,
      networkId,
      localDeviceId,
      remoteDeviceId,
      userId,
      localPublicKey,
      remotePublicKey
    }) => ({
      connectionId,
      serviceId,
      pairId,
      networkId,
      localDeviceId,
      remoteDeviceId,
      userId,
      localPublicKey,
      remotePublicKey
    })
  )
})
for (const item of baseline) {
  if (item.relative === 'core-state/runtime-owner/owner.json') continue
  const file = path.join(formal, item.relative)
  if (item.relative === 'settings/dsh-launcher/p2p-devices.json') {
    if (
      JSON.stringify(identity(json(file))) !==
      JSON.stringify(identity(json(path.join(evidence, 'profile', item.relative))))
    )
      throw new Error('Account/pair identity changed')
  } else if (item.relative === 'core-data/credentials.json') {
    const original = json(path.join(evidence, 'profile', item.relative))
    const saved = json(path.join(evidence, 'pre-install-credentials.json'))
    if (Object.keys(original).some((key) => original[key] !== saved[key]))
      throw new Error('An original encrypted credential changed before installation')
    if (
      digest(fs.readFileSync(file)) !==
      digest(fs.readFileSync(path.join(evidence, 'pre-install-credentials.json')))
    )
      throw new Error('A pre-install encrypted credential changed')
  } else if (digest(fs.readFileSync(file)) !== item.sha256)
    throw new Error(`Preserved formal record changed: ${item.relative}`)
}
const processes = JSON.parse(
  powershell(
    "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process | Select-Object Name,ProcessId,ParentProcessId,ExecutablePath,@{Name='Birth';Expression={if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToFileTimeUtc().ToString()}}}) | ConvertTo-Json -Compress"
  )
)
const ownerPath = path.join(formal, 'core-state/runtime-owner/owner.json')
const journalPath = path.join(formal, 'core-state/runtime-owner/recovery.json')
const prefs = json(path.join(formal, 'launch-preferences.json'))
if (prefs.port?.mode !== 'fixed') throw new Error('Explicit configured fixed port required')
const receiptPath = path.join(evidence, 'fixed-formal-running.json')

if (mode === '--running') {
  const owner = json(ownerPath)
  const journal = json(journalPath)
  if (
    owner.executableHash !== coreHash ||
    journal.containment !== 'windows-owner-job-v1' ||
    journal.phase !== 'active' ||
    journal.owner.instance !== owner.instance
  )
    throw new Error('Installed runtime containment authority mismatch')
  const process = processes.find(
    (p) => p.ProcessId === owner.process.pid && p.Birth === owner.process.creation
  )
  if (!process || path.resolve(process.ExecutablePath) !== path.resolve(coreExecutable))
    throw new Error('Exact runtime owner is absent')
  const core = processes.find((p) => p.ProcessId === process.ParentProcessId)
  const launcher = processes.find((p) => p.ProcessId === core?.ParentProcessId)
  if (
    !core ||
    !launcher ||
    path.resolve(launcher.ExecutablePath ?? '') !==
      path.resolve(resources, '../DSHKer Launcher.exe')
  )
    throw new Error('Formal process ancestry mismatch')
  const ids = new Set([launcher.ProcessId])
  for (let generation = 0; generation < processes.length; generation++) {
    const previous = ids.size
    for (const p of processes) if (ids.has(p.ParentProcessId)) ids.add(p.ProcessId)
    if (ids.size === previous) break
  }
  const log = fs.readFileSync(path.join(formal, 'logs/dsh-web.log'), 'utf8')
  const announced = [...log.matchAll(/^dsh web:\s+(http:\/\/\S+)\s*$/gm)].at(-1)?.[1]
  if (!announced || !log.includes('runtime is ready'))
    throw new Error('Actual runtime readiness absent')
  const url = new URL(announced)
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    Number(url.port) !== prefs.port.port ||
    url.username ||
    url.password ||
    !url.searchParams.get('token')
  )
    throw new Error('Unexpected runtime entry')
  let response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(8000) })
  if (response.status >= 300 && response.status < 400) {
    const next = new URL(response.headers.get('location'), url)
    if (next.origin !== url.origin) throw new Error('Unexpected external redirect')
    const cookie = response.headers
      .getSetCookie()
      .map((v) => v.split(';')[0])
      .join('; ')
    response = await fetch(next, {
      headers: { cookie },
      redirect: 'error',
      signal: AbortSignal.timeout(8000)
    })
  }
  const html = await response.text()
  if (!response.ok || !/<!doctype html|<html/i.test(html) || !/id=["'](?:root|app)["']/i.test(html))
    throw new Error('Actual DSH application response missing')
  const receipt = {
    at: new Date().toISOString(),
    version: expectedVersion,
    asarHash,
    coreHash,
    port: prefs.port.port,
    preservationPassed: true,
    kernelContainment: true,
    httpStatus: response.status,
    applicationRootPresent: true,
    processTree: processes
      .filter((p) => ids.has(p.ProcessId))
      .map(({ Name, ProcessId, ParentProcessId, Birth }) => ({
        Name,
        ProcessId,
        ParentProcessId,
        Birth
      })),
    compositorFrameAcceptance: false
  }
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n')
  console.log(
    JSON.stringify({
      stage: 'running',
      version: expectedVersion,
      preservationPassed: true,
      kernelContainment: true,
      httpStatus: response.status,
      processesObserved: receipt.processTree.length
    })
  )
} else {
  const prior = json(receiptPath)
  if (
    prior.version !== expectedVersion ||
    prior.asarHash !== asarHash ||
    prior.coreHash !== coreHash ||
    !prior.preservationPassed ||
    !prior.kernelContainment ||
    prior.httpStatus !== 200
  )
    throw new Error('Matching real running receipt required')
  if (
    prior.processTree.some((old) =>
      processes.some((p) => p.ProcessId === old.ProcessId && p.Birth === old.Birth)
    )
  )
    throw new Error('An exact formal process survived Quit')
  const executable = path.resolve(resources, '../DSHKer Launcher.exe').toLowerCase()
  if (
    processes.some((p) =>
      [executable, path.resolve(coreExecutable).toLowerCase()].includes(
        (p.ExecutablePath ?? '').toLowerCase()
      )
    )
  )
    throw new Error('Formal Launcher or core still running')
  if (fs.existsSync(ownerPath) || fs.existsSync(journalPath))
    throw new Error('Normal Quit retained runtime ownership records')
  await new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: prefs.port.port })
    socket.setTimeout(2000)
    socket.once('connect', () => {
      socket.destroy()
      reject(new Error('DSH port still listening'))
    })
    socket.once('timeout', () => {
      socket.destroy()
      reject(new Error('Port absence unconfirmed'))
    })
    socket.once('error', (error) =>
      error.code === 'ECONNREFUSED' ? resolve() : reject(new Error('Port absence unconfirmed'))
    )
  })
  const result = {
    at: new Date().toISOString(),
    version: expectedVersion,
    asarHash,
    coreHash,
    preservationPassed: true,
    allExactProcessesExited: true,
    portClosed: true,
    ownerRecordsRemoved: true,
    compositorFrameAcceptance: false
  }
  fs.writeFileSync(
    path.join(evidence, 'fixed-formal-quit.json'),
    JSON.stringify(result, null, 2) + '\n'
  )
  console.log(JSON.stringify(result))
}
