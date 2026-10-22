#!/usr/bin/env node
import asar from '@electron/asar'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const PACKAGED_CONTENT_EVIDENCE = '.run/packaged-content/verification.json'
const testDirectories =
  /^(?:__)?(?:tests?|specs?|e2e|fixtures?|testing|test[-_]?(?:support|utils?|helpers?|data))(?:__)?$/iu
const testFile = /(?:^|[._-])(?:test|spec|e2e)(?:[._-]|$)/iu
const testPackages =
  /^(?:@(?:vitest|jest|testing-library|playwright)(?:\/.*)?|(?:vitest|jest(?:-.*)?|sinon(?:-.*)?|nock|proxyquire|rewire|msw|chai|testdouble|mockery|puppeteer(?:-.*)?|playwright(?:-.*)?))$/iu

/** ASAR lists platform separators, including leading backslashes on Windows. */
export function normalizeArchiveMember(value) {
  return value.replaceAll('\\', '/').replace(/^\/+/, '')
}

function forbiddenMember(member) {
  const segments = member.split('/')
  if (segments.some((segment) => /mock|fixture/iu.test(segment) || testDirectories.test(segment)))
    return true
  if (testFile.test(segments.at(-1))) return true
  for (let index = 0; index < segments.length; index += 1) {
    if (segments[index] !== 'node_modules') continue
    const first = segments[index + 1]
    const name = first?.startsWith('@') ? `${first}/${segments[index + 2] ?? ''}` : first
    if (name && testPackages.test(name)) return true
  }
  return false
}

function manifestValid(manifest) {
  return (
    manifest !== null &&
    typeof manifest === 'object' &&
    typeof manifest.version === 'string' &&
    manifest.version.length > 0 &&
    typeof manifest.packageName === 'string' &&
    manifest.packageName.length > 0 &&
    typeof manifest.productName === 'string' &&
    manifest.productName.length > 0 &&
    ['stable', 'test'].includes(manifest.distributionChannel)
  )
}

async function digest(archive) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(archive)) hash.update(chunk)
  return hash.digest('hex')
}

async function nativeArchives(releaseDir, issues) {
  const archives = []
  const entries = await readdir(releaseDir, { withFileTypes: true })
  let nativeDirectories = 0
  for (const entry of entries) {
    const desktop = /^(?:win|linux)(?:-[a-z0-9]+)*-unpacked$/iu.test(entry.name)
    const mac = /^mac(?:-(?:arm64|x64|universal))?$/iu.test(entry.name)
    if (!desktop && !mac) continue
    nativeDirectories += 1
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      issues.push({ code: 'production_content.unpacked_invalid', archive: entry.name })
      continue
    }
    if (desktop) archives.push(path.join(releaseDir, entry.name, 'resources', 'app.asar'))
    else {
      const bundles = (
        await readdir(path.join(releaseDir, entry.name), { withFileTypes: true })
      ).filter((bundle) => bundle.name.endsWith('.app'))
      if (bundles.length === 0)
        issues.push({ code: 'production_content.archive_missing', archive: entry.name })
      for (const bundle of bundles) {
        if (!bundle.isDirectory() || bundle.isSymbolicLink()) {
          issues.push({
            code: 'production_content.unpacked_invalid',
            archive: `${entry.name}/${bundle.name}`
          })
          continue
        }
        archives.push(
          path.join(releaseDir, entry.name, bundle.name, 'Contents', 'Resources', 'app.asar')
        )
      }
    }
  }
  if (nativeDirectories === 0) issues.push({ code: 'production_content.unpacked_missing' })
  return archives.sort()
}

function readPackage(archive, member) {
  const nativeMember = member.split('/').join(path.sep)
  const entry = asar.statFile(archive, nativeMember, false)
  if ('link' in entry) throw new Error('linked package metadata')
  const value = JSON.parse(asar.extractFile(archive, nativeMember, false).toString('utf8'))
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid package metadata')
  return value
}

/** Reads every listed member of each native ASAR; it never extracts or executes package contents. */
export async function scanPackagedContent(releaseDir, suppliedManifest) {
  const issues = []
  const reports = []
  const report = {
    ok: false,
    releaseDir: path.relative(appRoot, releaseDir).replaceAll(path.sep, '/'),
    archives: reports,
    issues
  }
  const relative = path.relative(appRoot, releaseDir)
  if (
    relative === '' ||
    relative.startsWith(`..${path.sep}`) ||
    relative === '..' ||
    path.isAbsolute(relative)
  ) {
    issues.push({ code: 'production_content.release_directory_invalid' })
    return report
  }
  let manifest = suppliedManifest
  try {
    manifest ??= JSON.parse(await readFile(path.join(releaseDir, 'release-manifest.json'), 'utf8'))
  } catch {
    issues.push({ code: 'production_content.manifest_missing_or_invalid' })
    return report
  }
  if (!manifestValid(manifest)) {
    issues.push({ code: 'production_content.manifest_missing_or_invalid' })
    return report
  }
  let archives
  try {
    archives = await nativeArchives(releaseDir, issues)
  } catch {
    issues.push({ code: 'production_content.release_directory_unreadable' })
    return report
  }
  for (const archive of archives) {
    const archiveName = path.relative(releaseDir, archive).replaceAll(path.sep, '/')
    const result = { archive: archiveName, ok: false, members: 0, packages: 0 }
    reports.push(result)
    const startingIssues = issues.length
    const info = await lstat(archive).catch(() => undefined)
    if (!info?.isFile() || info.isSymbolicLink()) {
      issues.push({ code: 'production_content.archive_missing_or_invalid', archive: archiveName })
      continue
    }
    try {
      // The library caches headers by path. A rebuild at the same path must be
      // scanned again rather than inheriting an earlier candidate's header.
      asar.uncache(archive)
      const members = asar.listPackage(archive, { isPack: false }).map(normalizeArchiveMember)
      result.members = members.length
      result.sha256 = await digest(archive)
      for (const member of members) {
        if (
          member.split('/').some((segment) => segment === '..' || segment === '.') ||
          member.includes('\0')
        ) {
          issues.push({ code: 'production_content.member_invalid', archive: archiveName, member })
          continue
        }
        if (forbiddenMember(member))
          issues.push({ code: 'production_content.test_member', archive: archiveName, member })
      }
      let metadata
      try {
        metadata = readPackage(archive, 'package.json')
        if (
          metadata.version !== manifest.version ||
          metadata.name !== manifest.packageName ||
          metadata.dshkerDistributionChannel !== manifest.distributionChannel
        ) {
          issues.push({
            code: 'production_content.identity_mismatch',
            archive: archiveName,
            member: 'package.json'
          })
        }
      } catch {
        issues.push({
          code: 'production_content.package_metadata_missing_or_invalid',
          archive: archiveName,
          member: 'package.json'
        })
      }
      for (const member of members.filter((value) =>
        /(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+\/package\.json$/u.test(value)
      )) {
        try {
          const dependency = readPackage(archive, member)
          result.packages += 1
          const description = [
            dependency.name,
            dependency.description,
            ...(Array.isArray(dependency.keywords) ? dependency.keywords : [])
          ]
            .filter((value) => typeof value === 'string')
            .join(' ')
          if (/mock/iu.test(description) || testPackages.test(dependency.name ?? '')) {
            issues.push({
              code: 'production_content.test_dependency',
              archive: archiveName,
              member
            })
          }
        } catch {
          issues.push({
            code: 'production_content.dependency_metadata_invalid',
            archive: archiveName,
            member
          })
        }
      }
      result.ok = issues.length === startingIssues
    } catch {
      issues.push({ code: 'production_content.archive_unreadable', archive: archiveName })
    } finally {
      asar.uncache(archive)
    }
  }
  report.ok = reports.length > 0 && issues.length === 0 && reports.every((archive) => archive.ok)
  return report
}

/** Evidence has a fixed repository-local destination; archive and manifest inputs stay read-only. */
export async function writePackagedContentEvidence(report) {
  const output = path.join(appRoot, PACKAGED_CONTENT_EVIDENCE)
  await mkdir(path.dirname(output), { recursive: true })
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

async function main() {
  let releaseDir = 'release'
  let json = false
  for (let index = 2; index < process.argv.length; index += 1) {
    const argument = process.argv[index]
    if (argument === '--json') json = true
    else if (
      argument === '--release-dir' &&
      process.argv[index + 1] &&
      !process.argv[index + 1].startsWith('--')
    )
      releaseDir = process.argv[++index]
    else throw new Error('Usage: node tools/packaged-content.mjs --release-dir <path> --json')
  }
  const report = await scanPackagedContent(path.resolve(appRoot, releaseDir))
  await writePackagedContentEvidence(report)
  if (json) console.log(JSON.stringify(report, null, 2))
  else
    console.log(
      report.ok
        ? 'Packaged production content verified.'
        : `Packaged content refused: ${report.issues.map((issue) => issue.code).join(', ')}`
    )
  if (!report.ok) process.exitCode = 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`packaged-content: ${error.message}`)
    process.exitCode = 1
  })
}
