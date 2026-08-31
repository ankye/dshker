import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const DEFAULT_REMOTE_DEBUGGING_PORT = '9223'
const ELECTRON_VITE_BIN = fileURLToPath(
  new URL('../node_modules/electron-vite/bin/electron-vite.js', import.meta.url)
)

function readRemoteDebuggingPort(args) {
  let port = DEFAULT_REMOTE_DEBUGGING_PORT
  const passthrough = []

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--remote-debugging-port') {
      port = args[index + 1] || DEFAULT_REMOTE_DEBUGGING_PORT
      index += 1
      continue
    }

    if (arg.startsWith('--remote-debugging-port=')) {
      port = arg.slice('--remote-debugging-port='.length)
      continue
    }

    passthrough.push(arg)
  }

  if (!/^\d+$/.test(port)) {
    throw new Error(`Invalid remote debugging port: ${port}`)
  }

  const portNumber = Number(port)
  if (portNumber < 1024 || portNumber > 65535) {
    throw new Error(`Remote debugging port must be between 1024 and 65535: ${port}`)
  }

  return { port, passthrough }
}

const { port, passthrough } = readRemoteDebuggingPort(process.argv.slice(2))
const child = spawn(process.execPath, [ELECTRON_VITE_BIN, 'dev', ...passthrough], {
  env: {
    ...process.env,
    ELECTRON_REMOTE_DEBUGGING_PORT: port
  },
  stdio: 'inherit',
  shell: false
})

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  process.exit(code ?? 0)
})

child.on('error', (error) => {
  console.error(error)
  process.exit(1)
})
