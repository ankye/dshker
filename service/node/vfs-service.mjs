#!/usr/bin/env node

const code = 'service.vfs_removed'
const message =
  'DSHKer Launcher does not expose the template VFS service. Use the managed-root and desktop-bridge workflows when they are implemented.'

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ ok: false, code, message }))
} else {
  console.error(code + ': ' + message)
}

process.exitCode = 1
