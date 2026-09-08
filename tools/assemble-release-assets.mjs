#!/usr/bin/env node
// Assemble and verify per-platform release assets into ./publish for a GitHub
// Release. Each platform artifact directory (release-input/<platform>) must
// contain its release-manifest.json, checksums.txt, and installer(s).
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const packageJson = JSON.parse(await readFile('package.json', 'utf8'))
const expectedTag = 'v' + packageJson.version
const expectedGitRevision = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
  encoding: 'utf8'
}).trim()
if (process.env.GITHUB_REF_NAME !== expectedTag) {
  throw new Error(
    'Tag ' + process.env.GITHUB_REF_NAME + ' does not match package.json version ' + expectedTag
  )
}

async function listFiles(root) {
  const files = []
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name)
      if (entry.isDirectory()) await walk(absolute)
      else if (entry.isFile()) files.push(absolute)
    }
  }
  await walk(root)
  return files.sort((left, right) => left.localeCompare(right))
}

function requireOne(files, predicate, label) {
  const matches = files.filter(predicate)
  if (matches.length !== 1) {
    throw new Error('Expected exactly one ' + label + ', found ' + matches.length)
  }
  return matches[0]
}

async function sha256(file) {
  return createHash('sha256')
    .update(await readFile(file))
    .digest('hex')
}

async function readPlatformManifest(root, platform, architecture) {
  const files = await listFiles(root)
  const manifestPath = requireOne(
    files,
    (file) => path.basename(file) === 'release-manifest.json',
    platform + '/' + architecture + ' release-manifest.json'
  )
  const checksumsPath = requireOne(
    files,
    (file) => path.basename(file) === 'checksums.txt',
    platform + '/' + architecture + ' checksums.txt'
  )
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (manifest.version !== packageJson.version) {
    throw new Error(platform + '/' + architecture + ' manifest version does not match package.json')
  }
  if (
    manifest.packageName !== packageJson.name ||
    manifest.productName !== packageJson.build.productName ||
    manifest.appId !== packageJson.build.appId ||
    manifest.gitRevision !== expectedGitRevision
  ) {
    throw new Error(platform + '/' + architecture + ' manifest source identity is invalid')
  }
  if (manifest.platform !== platform || manifest.architecture !== architecture) {
    throw new Error(platform + '/' + architecture + ' manifest platform identity is invalid')
  }
  if (manifest.signingStatus !== 'unsigned-local') {
    throw new Error(platform + '/' + architecture + ' manifest signing status is unexpected')
  }
  return { files, manifest, checksumsPath }
}

async function verifyInstaller({
  files,
  manifest,
  checksumsPath,
  installer,
  platform,
  architecture
}) {
  const installerName = path.basename(installer)
  const manifestEntries = manifest.artifacts.filter(
    (artifact) =>
      artifact.kind === 'file' &&
      artifact.name === installerName &&
      artifact.relativePath === installerName
  )
  if (manifestEntries.length !== 1) {
    throw new Error(
      platform + '/' + architecture + ' manifest does not identify exactly one ' + installerName
    )
  }
  const digest = await sha256(installer)
  if (manifestEntries[0].sha256 !== digest) {
    throw new Error(
      platform + '/' + architecture + ' ' + installerName + ' does not match its manifest checksum'
    )
  }
  const checksumRows = (await readFile(checksumsPath, 'utf8')).trimEnd().split('\n').filter(Boolean)
  if (!checksumRows.includes(digest + '  ' + installerName)) {
    throw new Error(
      platform + '/' + architecture + ' ' + installerName + ' does not match checksums.txt'
    )
  }
  await copyFile(installer, path.join('publish', installerName))
  return digest + '  ' + installerName
}

async function collectPlatform({ root, target, platform, architecture, outputManifest }) {
  const { files, manifest, checksumsPath } = await readPlatformManifest(
    root,
    platform,
    architecture
  )
  const expectedInstallerName = 'dshker-launcher-' + packageJson.version + '-' + target
  const extension = path.extname(expectedInstallerName)
  const installer = requireOne(
    files,
    (file) => path.extname(file).toLowerCase() === extension,
    platform + '/' + architecture + ' ' + extension + ' installer'
  )
  if (path.basename(installer) !== expectedInstallerName) {
    throw new Error(
      platform + '/' + architecture + ' installer name is not ' + expectedInstallerName
    )
  }
  const row = await verifyInstaller({
    files,
    manifest,
    checksumsPath,
    installer,
    platform,
    architecture
  })
  await copyFile(
    requireOne(files, (file) => path.basename(file) === 'release-manifest.json', 'manifest'),
    path.join('publish', outputManifest)
  )
  return row
}

// Linux publishes two installers per architecture (AppImage + deb). Their arch
// suffix differs from the electron-builder arch token, so collect each present
// installer generically and require both AppImage and deb.
async function collectLinux({ root, platform, architecture, outputManifest }) {
  const { files, manifest, checksumsPath } = await readPlatformManifest(
    root,
    platform,
    architecture
  )
  const rows = []
  for (const file of files) {
    const ext = path.extname(file).toLowerCase()
    if (ext !== '.appimage' && ext !== '.deb') continue
    rows.push(
      await verifyInstaller({
        files,
        manifest,
        checksumsPath,
        installer: file,
        platform,
        architecture
      })
    )
  }
  if (rows.length !== 2) {
    throw new Error(
      platform +
        '/' +
        architecture +
        ' expected AppImage + deb, found ' +
        rows.length +
        ' installers'
    )
  }
  await copyFile(
    requireOne(files, (file) => path.basename(file) === 'release-manifest.json', 'manifest'),
    path.join('publish', outputManifest)
  )
  return rows
}

await mkdir('publish', { recursive: false })
const checksumRows = []
checksumRows.push(
  await collectPlatform({
    root: 'release-input/macos-arm64',
    target: 'mac-arm64.dmg',
    platform: 'darwin',
    architecture: 'arm64',
    outputManifest: 'release-manifest-macos-arm64.json'
  })
)
checksumRows.push(
  await collectPlatform({
    root: 'release-input/macos-x64',
    target: 'mac-x64.dmg',
    platform: 'darwin',
    architecture: 'x64',
    outputManifest: 'release-manifest-macos-x64.json'
  })
)
checksumRows.push(
  await collectPlatform({
    root: 'release-input/windows-x64',
    target: 'win-x64.exe',
    platform: 'win32',
    architecture: 'x64',
    outputManifest: 'release-manifest-windows-x64.json'
  })
)
checksumRows.push(
  await collectPlatform({
    root: 'release-input/windows-arm64',
    target: 'win-arm64.exe',
    platform: 'win32',
    architecture: 'arm64',
    outputManifest: 'release-manifest-windows-arm64.json'
  })
)
for (const row of await collectLinux({
  root: 'release-input/linux-x64',
  platform: 'linux',
  architecture: 'x64',
  outputManifest: 'release-manifest-linux-x64.json'
}))
  checksumRows.push(row)
for (const row of await collectLinux({
  root: 'release-input/linux-arm64',
  platform: 'linux',
  architecture: 'arm64',
  outputManifest: 'release-manifest-linux-arm64.json'
}))
  checksumRows.push(row)
await writeFile('publish/checksums.txt', checksumRows.join('\n') + '\n', 'utf8')
