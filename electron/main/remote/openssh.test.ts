import { describe, expect, it } from 'vitest'
import type { RemoteComputerView } from '../../../src/shared/contracts'
import {
  buildScpArguments,
  buildSshForwardArguments,
  parseRemoteRuntimeUrl,
  resolveOpenSshExecutables
} from './openssh'

const computer: RemoteComputerView = {
  connectionId: '11111111-1111-4111-8111-111111111111',
  displayName: 'Studio Mac',
  host: '10.147.17.251',
  port: 22,
  user: 'a1021500932'
}

describe('OpenSSH remote contract', () => {
  it('uses strict non-interactive loopback forwarding with no shell command', () => {
    expect(buildSshForwardArguments(computer, 3081, 3080)).toEqual([
      '-N',
      '-T',
      '-o',
      'BatchMode=yes',
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-p',
      '22',
      '-L',
      '127.0.0.1:3081:127.0.0.1:3080',
      'a1021500932@10.147.17.251'
    ])
  })

  it('copies only the fixed peer descriptor with batch SCP', () => {
    expect(buildScpArguments(computer, '/tmp/peer.json')).toEqual([
      '-q',
      '-B',
      '-o',
      'StrictHostKeyChecking=yes',
      '-P',
      '22',
      'a1021500932@10.147.17.251:.dshlauncher/remote-peer.json',
      '/tmp/peer.json'
    ])
  })

  it('preserves an explicit loopback URL and rejects unsafe authority', () => {
    expect(parseRemoteRuntimeUrl('http://127.0.0.1:3080/path?token=abc')).toMatchObject({
      port: 3080
    })
    expect(() => parseRemoteRuntimeUrl('http://10.0.0.1:3080/?token=abc')).toThrowError(/loopback/u)
    expect(() => parseRemoteRuntimeUrl('file:///tmp/a')).toThrowError(/loopback/u)
    expect(() => parseRemoteRuntimeUrl('http://127.0.0.1/')).toThrowError(/loopback/u)
  })

  it('resolves explicit macOS and Windows OpenSSH commands', () => {
    expect(resolveOpenSshExecutables('darwin')).toEqual({
      ssh: '/usr/bin/ssh',
      scp: '/usr/bin/scp'
    })
    expect(resolveOpenSshExecutables('win32')).toEqual({ ssh: 'ssh.exe', scp: 'scp.exe' })
  })
})
