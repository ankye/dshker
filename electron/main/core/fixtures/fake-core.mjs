#!/usr/bin/env node
// Fake dshkerd for the CoreSupervisor unit tests: consumes the one-shot
// bootstrap from stdin, creates the private endpoint itself, authenticates
// exactly one parent, and answers core.version. Mirrors the Go core entry
// (networking/cmd/dshkerd) closely enough to exercise the whole handshake.
'use strict'

import { createServer } from 'node:net'
import { mkdirSync, writeFileSync } from 'node:fs'

const collect = (stream) =>
  new Promise((resolve, reject) => {
    const chunks = []
    stream.on('data', (chunk) => chunks.push(chunk))
    stream.on('end', () => resolve(Buffer.concat(chunks)))
    stream.on('error', reject)
  })

const bootstrap = JSON.parse((await collect(process.stdin)).toString('utf8'))
if (
  bootstrap.version !== 1 ||
  typeof bootstrap.socket !== 'string' ||
  typeof bootstrap.secret !== 'string' ||
  !/^[a-f0-9]{64}$/.test(bootstrap.secret)
)
  throw new Error('p2p.invalid_bootstrap')

if (process.env.FAKE_CORE_ARGV_OUT) {
  mkdirSync(process.env.FAKE_CORE_ARGV_OUT, { recursive: true })
  writeFileSync(
    process.env.FAKE_CORE_ARGV_OUT + '/argv.json',
    JSON.stringify(process.argv.slice(2))
  )
  writeFileSync(process.env.FAKE_CORE_ARGV_OUT + '/pid.json', JSON.stringify(process.pid))
}

const server = createServer((socket) => serve(socket, bootstrap.secret, server))
server.on('error', () => process.exit(1))
server.listen(bootstrap.socket, () => {
  process.stdout.write(JSON.stringify({ version: 1, ready: true }) + '\n')
})

process.on('SIGTERM', () => process.exit(0))

function serve(socket, secret, server) {
  let buffer = Buffer.alloc(0)
  let authenticated = false
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    let newline
    while ((newline = buffer.indexOf(10)) >= 0) {
      const line = buffer.subarray(0, newline)
      buffer = buffer.subarray(newline + 1)
      let frame
      try {
        frame = JSON.parse(line.toString('utf8'))
      } catch {
        socket.destroy()
        server.close()
        return
      }
      if (frame.version !== 1) {
        socket.destroy()
        server.close()
        return
      }
      if (!authenticated) {
        if (frame.secret === secret) {
          authenticated = true
          socket.write(JSON.stringify({ version: 1, authenticated: true }) + '\n')
        } else {
          socket.destroy()
          server.close()
        }
        continue
      }
      if (!frame.method) continue
      if (frame.method === 'core.version') {
        socket.write(
          JSON.stringify({
            version: 1,
            id: frame.id,
            method: '',
            payload: { version: 1, methodTableVersion: 1, methods: ['core.version'] },
            error: ''
          }) + '\n'
        )
      } else {
        socket.write(
          JSON.stringify({
            version: 1,
            id: frame.id,
            method: '',
            payload: {},
            error: 'p2p.not_implemented'
          }) + '\n'
        )
      }
    }
  })
  socket.on('error', () => undefined)
  socket.on('close', () => server.close())
}
