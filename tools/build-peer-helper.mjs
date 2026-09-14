import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
if (args.length !== 4 || args[0] !== '--platform' || args[2] !== '--arch')
  throw new Error('Explicit --platform darwin|linux|win32 --arch arm64|x64 required')
const [, platform, , arch] = args
if (!['darwin', 'linux', 'win32'].includes(platform) || !['arm64', 'x64'].includes(arch))
  throw new Error('Unsupported helper target')
const root = fileURLToPath(new URL('..', import.meta.url))
const target = `${platform}-${arch}`
const directory = resolve(root, 'build/p2p', target)
await mkdir(directory, { recursive: true })
const run = promisify(execFile)
const environment = {
  ...process.env,
  GOOS: platform === 'win32' ? 'windows' : platform === 'linux' ? 'linux' : 'darwin',
  GOARCH: arch === 'x64' ? 'amd64' : 'arm64',
  CGO_ENABLED: '0'
}
const cwd = resolve(root, 'networking')
// One binary ships now: dshkerd is the whole core, and the shell starts nothing
// else. dshker-peer is no longer built or packaged — it was kept only until the
// core answered the peer table itself, which it has since task 3.7.
const artifacts = [{ package: './cmd/dshkerd', file: 'dshkerd', manifest: 'dshkerd-manifest.json' }]
for (const artifact of artifacts) {
  const outputName = platform === 'win32' ? artifact.file + '.exe' : artifact.file
  const output = resolve(directory, outputName)
  const { stdout } = await run('go', ['list', '-deps', '-f', '{{.ImportPath}}', artifact.package], {
    cwd,
    env: environment
  })
  for (const dependency of stdout.trim().split('\n')) {
    if (/(?:^|\/)(?:integration|fixtures?|mocks?|testsupport)(?:\/|$)/i.test(dependency))
      throw new Error('Test-only dependency in helper: ' + dependency)
  }
  await run('go', ['build', '-mod=readonly', '-trimpath', '-o', output, artifact.package], {
    cwd,
    env: environment
  })
  // Generated resource metadata. Rebuild after any executable transformation.
  const sha256 = createHash('sha256')
    .update(await readFile(output))
    .digest('hex')
  await writeFile(
    resolve(directory, artifact.manifest),
    JSON.stringify({ version: 1, target, file: outputName, sha256 }) + '\n'
  )
  console.log(
    JSON.stringify({ target, artifact: artifact.file, output: 'build/p2p/' + target, sha256 })
  )
}
