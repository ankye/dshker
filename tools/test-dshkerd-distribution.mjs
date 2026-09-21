#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const target =
  process.platform === 'darwin'
    ? `darwin-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
    : process.platform === 'win32'
      ? `windows-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
      : `linux-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
const extension = target.startsWith('windows') ? 'zip' : 'tar.gz'
const temporaryDir = await mkdtemp(path.join(os.tmpdir(), 'dshkerd-distribution-test-'))

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function expectFailure(args) {
  try {
    await run(
      process.execPath,
      [path.join(root, 'tools', 'build-dshkerd-distribution.mjs'), ...args],
      {
        cwd: root
      }
    )
  } catch (error) {
    return error
  }
  throw new Error('Expected command to fail: ' + args.join(' '))
}

try {
  await run(
    process.execPath,
    [
      path.join(root, 'tools', 'build-dshkerd-distribution.mjs'),
      '--target',
      target,
      '--output-dir',
      temporaryDir,
      '--overwrite'
    ],
    { cwd: root }
  )
  const version = packageJson.version
  const archiveName = `dshkerd-${version}-${target}.${extension}`
  const archive = await readFile(path.join(temporaryDir, archiveName))
  const manifest = JSON.parse(
    await readFile(path.join(temporaryDir, `dshkerd-${version}-manifest.json`), 'utf8')
  )
  if (manifest.version !== version || manifest.artifacts.length !== 1)
    throw new Error('Invalid manifest')
  if (manifest.artifacts[0].target !== target) throw new Error('Manifest target mismatch')
  if (manifest.artifacts[0].archiveSha256 !== sha256(archive))
    throw new Error('Archive checksum mismatch')
  const checksums = await readFile(
    path.join(temporaryDir, `dshkerd-${version}-checksums.txt`),
    'utf8'
  )
  if (!checksums.includes(`${sha256(archive)}  ${archiveName}`))
    throw new Error('Checksum row missing')
  const archiveStat = await stat(path.join(temporaryDir, archiveName))
  if (!archiveStat.isFile()) throw new Error('Archive is not a regular file')

  const unsupported = await expectFailure([
    '--target',
    'unsupported-target',
    '--output-dir',
    path.join(temporaryDir, 'unsupported')
  ])
  if (!String(unsupported.stderr).includes('Unsupported target'))
    throw new Error('Wrong-target refusal is unclear')

  const tampered = Buffer.concat([archive, Buffer.from('tamper')])
  if (sha256(tampered) === manifest.artifacts[0].archiveSha256)
    throw new Error('Tampered archive was accepted')
  await writeFile(path.join(temporaryDir, 'tampered.archive'), tampered)
  console.log(
    JSON.stringify({
      ok: true,
      target,
      archive: archiveName,
      wrongTargetRefused: true,
      tamperDetected: true
    })
  )
} finally {
  await rm(temporaryDir, { recursive: true, force: true })
}
