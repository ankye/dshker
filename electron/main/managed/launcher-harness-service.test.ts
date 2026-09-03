import { execFile } from 'node:child_process'
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import nodePath from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
  LAUNCH_PREFERENCES_FORMAT,
  assertPortSetting,
  parseAnnouncedWebUrl,
  parseLaunchPreferencesPort,
  parseProfilePluginRecords,
  normalizeGitRemote,
  localPathOf,
  gitUrlOf,
  formatLauncherLifecycleEvent,
  classifyChildConsoleStream,
  launcherWebStartArguments
} from './launcher-harness-service'
import {
  cleanLauncherHarnessCheckout,
  launcherProfilePluginArguments
} from './launcher-harness-commands'

const execFileAsync = promisify(execFile)

async function hostGit(cwd: string, arguments_: readonly string[]): Promise<void> {
  await execFileAsync('git', [...arguments_], { cwd, encoding: 'utf8' })
}

describe('formatLauncherLifecycleEvent', () => {
  it('marks Launcher lifecycle diagnostics separately from child output', () => {
    expect(formatLauncherLifecycleEvent('Waiting for readiness.')).toBe(
      '[launcher] Waiting for readiness.\n'
    )
  })
})

describe('classifyChildConsoleStream', () => {
  it('shows pnpm script echoes as commands even though pnpm writes them to stderr', () => {
    expect(
      classifyChildConsoleStream('stderr', '$ node --import tsx/esm apps/cli/src/bin.ts -- web\n')
    ).toBe('command')
  })

  it('keeps an actual stderr diagnostic in the error stream', () => {
    expect(classifyChildConsoleStream('stderr', 'Error: address already in use\n')).toBe('stderr')
  })
})

describe('launcherWebStartArguments', () => {
  it('mounts the Launcher-owned verbose overlay without changing the DSH home', () => {
    expect(
      launcherWebStartArguments('/launcher/settings/verbose.patch.yml', {
        mode: 'fixed',
        port: 3088
      })
    ).toEqual([
      'dsh',
      'web',
      '--patch',
      '/launcher/settings/verbose.patch.yml',
      '--no-open',
      '--port',
      '3088'
    ])
  })
})

describe('launcherProfilePluginArguments', () => {
  it('uses the DSH profile forwarder without a pnpm argument separator', () => {
    expect(launcherProfilePluginArguments('update')).toEqual([
      'dsh',
      'plugin',
      '--profile',
      'web',
      'update'
    ])
  })
})

describe('cleanLauncherHarnessCheckout', () => {
  it('removes ignored and untracked build residue while preserving tracked source', async () => {
    const root = await mkdtemp(nodePath.join(tmpdir(), 'dsh-launcher-clean-'))
    try {
      await hostGit(root, ['init'])
      await hostGit(root, ['config', 'user.email', 'launcher-test@example.test'])
      await hostGit(root, ['config', 'user.name', 'DSHKer Launcher Test'])
      await writeFile(nodePath.join(root, '.gitignore'), 'node_modules/\n', 'utf8')
      await writeFile(nodePath.join(root, 'tracked-source.txt'), 'source\n', 'utf8')
      await hostGit(root, ['add', '.gitignore', 'tracked-source.txt'])
      await hostGit(root, ['commit', '-m', 'initial'])
      await mkdir(nodePath.join(root, 'node_modules'))
      await writeFile(nodePath.join(root, 'node_modules', 'stale.txt'), 'stale\n', 'utf8')
      await writeFile(nodePath.join(root, 'generated.txt'), 'generated\n', 'utf8')

      await cleanLauncherHarnessCheckout('git', root)

      await expect(access(nodePath.join(root, 'node_modules'))).rejects.toThrow()
      await expect(access(nodePath.join(root, 'generated.txt'))).rejects.toThrow()
      await expect(readFile(nodePath.join(root, 'tracked-source.txt'), 'utf8')).resolves.toBe(
        'source\n'
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('parseAnnouncedWebUrl', () => {
  it('reads the exact URL DSH announced, preserving its session credential', () => {
    expect(parseAnnouncedWebUrl('dsh web: http://127.0.0.1:3080/?token=abc123\n')).toBe(
      'http://127.0.0.1:3080/?token=abc123'
    )
  })

  it('accepts the announcement on any line of a buffered chunk', () => {
    const chunk = 'building\ndsh web: http://127.0.0.1:41234/\nready\n'
    expect(parseAnnouncedWebUrl(chunk)).toBe('http://127.0.0.1:41234/')
  })

  it('keeps the port DSH chose rather than a launcher-assumed default', () => {
    expect(parseAnnouncedWebUrl('dsh web: http://127.0.0.1:59999/')).toContain(':59999')
  })

  it('ignores the LAN address printed after the loopback URL', () => {
    const line = 'dsh web: http://127.0.0.1:3080/ (LAN: http://192.168.1.4:3080/)'
    expect(parseAnnouncedWebUrl(line)).toBe('http://127.0.0.1:3080/')
  })

  it('rejects a non-loopback host so a log line cannot redirect the runtime view', () => {
    expect(parseAnnouncedWebUrl('dsh web: http://example.test:3080/')).toBeUndefined()
    expect(parseAnnouncedWebUrl('dsh web: http://192.168.1.4:3080/')).toBeUndefined()
  })

  it('rejects a non-http scheme', () => {
    expect(parseAnnouncedWebUrl('dsh web: file:///etc/passwd')).toBeUndefined()
    expect(parseAnnouncedWebUrl('dsh web: javascript:alert(1)')).toBeUndefined()
  })

  it('returns undefined for unrelated output and malformed announcements', () => {
    expect(parseAnnouncedWebUrl('')).toBeUndefined()
    expect(parseAnnouncedWebUrl('compiling packages...')).toBeUndefined()
    expect(parseAnnouncedWebUrl('dsh web:')).toBeUndefined()
    expect(parseAnnouncedWebUrl('dsh web: not-a-url')).toBeUndefined()
    // A quoted mention inside prose is not the launcher's own startup line.
    expect(parseAnnouncedWebUrl('see "dsh web: <url>" in the docs')).toBeUndefined()
  })
})

describe('parseProfilePluginRecords', () => {
  it('marks template bundles as default layers and dependencies as user plugins', () => {
    const manifest = {
      name: 'dsh-profile-web',
      dependencies: { 'dsh-pet': 'github:a/b' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-pet'] } }
    }
    expect(parseProfilePluginRecords(manifest)).toEqual([
      { name: 'dsh-pet', version: 'github:a/b', origin: 'user' },
      { name: '@deepseek-ai/dsh-base', version: '', origin: 'default' }
    ])
  })

  it('returns only template defaults when no dependency is installed', () => {
    const manifest = {
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } }
    }
    expect(parseProfilePluginRecords(manifest).map((plugin) => plugin.origin)).toEqual([
      'default',
      'default'
    ])
  })

  it('rejects malformed dependency and bundle records instead of guessing', () => {
    expect(() => parseProfilePluginRecords({ dependencies: ['nope'] })).toThrow()
    expect(() => parseProfilePluginRecords({ dsh: { profile: { bundles: [42] } } })).toThrow()
    expect(() => parseProfilePluginRecords('nope')).toThrow()
  })
})

describe('assertPortSetting', () => {
  it('admits an unprivileged fixed port', () => {
    expect(assertPortSetting({ mode: 'fixed', port: 8080 })).toEqual({ mode: 'fixed', port: 8080 })
  })

  it('admits both ends of the accepted range', () => {
    expect(assertPortSetting({ mode: 'fixed', port: 1024 })).toEqual({ mode: 'fixed', port: 1024 })
    expect(assertPortSetting({ mode: 'fixed', port: 65_535 })).toEqual({
      mode: 'fixed',
      port: 65_535
    })
  })

  it('normalizes an automatic selection to a bare mode', () => {
    expect(assertPortSetting({ mode: 'auto' })).toEqual({ mode: 'auto' })
  })

  it('rejects a privileged port that would need elevated rights to bind', () => {
    expect(() => assertPortSetting({ mode: 'fixed', port: 80 })).toThrow()
  })

  it('rejects a port above the TCP range', () => {
    expect(() => assertPortSetting({ mode: 'fixed', port: 65_536 })).toThrow()
  })

  it('rejects a fractional or non-finite port before it reaches spawn arguments', () => {
    expect(() => assertPortSetting({ mode: 'fixed', port: 8080.5 })).toThrow()
    expect(() => assertPortSetting({ mode: 'fixed', port: Number.NaN })).toThrow()
  })
})

describe('parseLaunchPreferencesPort', () => {
  it('reads a persisted fixed port', () => {
    const text = JSON.stringify({
      format: LAUNCH_PREFERENCES_FORMAT,
      port: { mode: 'fixed', port: 8080 }
    })
    expect(parseLaunchPreferencesPort(text)).toEqual({ mode: 'fixed', port: 8080 })
  })

  it('falls back to automatic for a foreign document format', () => {
    const text = JSON.stringify({ format: 'other', port: { mode: 'fixed', port: 8080 } })
    expect(parseLaunchPreferencesPort(text)).toEqual({ mode: 'auto' })
  })

  it('falls back to automatic for malformed JSON', () => {
    expect(parseLaunchPreferencesPort('{ not json')).toEqual({ mode: 'auto' })
  })

  it('falls back to automatic for an out-of-range persisted port', () => {
    const text = JSON.stringify({
      format: LAUNCH_PREFERENCES_FORMAT,
      port: { mode: 'fixed', port: 80 }
    })
    expect(parseLaunchPreferencesPort(text)).toEqual({ mode: 'auto' })
  })
})

describe('normalizeGitRemote', () => {
  it('reduces an SSH remote to its comparable HTTPS form', () => {
    expect(normalizeGitRemote('git@github.com:ankye/dsh_use_browser.git')).toBe(
      'https://github.com/ankye/dsh_use_browser'
    )
  })

  it('handles an ssh:// remote carrying an explicit port', () => {
    expect(normalizeGitRemote('ssh://git@git.example.com:2022/team/repo.git')).toBe(
      'https://git.example.com/team/repo'
    )
  })

  it('drops a .git suffix from an HTTPS remote', () => {
    expect(normalizeGitRemote('https://github.com/owner/name.git')).toBe(
      'https://github.com/owner/name'
    )
  })

  it('leaves an already-normal HTTPS remote unchanged', () => {
    expect(normalizeGitRemote('https://github.com/owner/name')).toBe(
      'https://github.com/owner/name'
    )
  })

  it('rejects a value that names no remote', () => {
    expect(normalizeGitRemote('   ')).toBeUndefined()
    expect(normalizeGitRemote('file:/tmp/local')).toBeUndefined()
  })
})

describe('localPathOf', () => {
  it('reads the checkout path of a file dependency', () => {
    expect(localPathOf('file:/fixtures/plugins/thing')).toBe('/fixtures/plugins/thing')
  })

  it('ignores a version that is not a local path', () => {
    expect(localPathOf('1.2.3')).toBeUndefined()
    expect(localPathOf('file:')).toBeUndefined()
  })
})

describe('gitUrlOf', () => {
  it('accepts a direct git dependency specifier', () => {
    expect(gitUrlOf('git+https://github.com/owner/name.git')).toBe('https://github.com/owner/name')
  })

  it('ignores a semver version', () => {
    expect(gitUrlOf('^2.0.0')).toBeUndefined()
  })
})

describe('parseAnnouncedWebUrl', () => {
  it('keeps the session credential DSH puts in the query', () => {
    expect(parseAnnouncedWebUrl('dsh web: http://127.0.0.1:3088/?token=abc123\n')).toBe(
      'http://127.0.0.1:3088/?token=abc123'
    )
  })

  it('reads the loopback URL even when a LAN address follows it', () => {
    expect(
      parseAnnouncedWebUrl(
        'dsh web: http://127.0.0.1:3088/?token=abc (LAN: http://192.168.1.5:3088/?token=abc)\n'
      )
    ).toBe('http://127.0.0.1:3088/?token=abc')
  })

  it('ignores the browser-hint line DSH also prefixes with dsh web', () => {
    expect(
      parseAnnouncedWebUrl('dsh web: opening the default browser; pass --no-open to disable\n')
    ).toBeUndefined()
  })

  it('rejects a non-loopback address', () => {
    expect(parseAnnouncedWebUrl('dsh web: http://10.0.0.9:3088/?token=abc\n')).toBeUndefined()
  })

  it('admits a truncated URL when handed one, so callers must buffer lines', () => {
    // Documents why #appendConsole splits on newlines before parsing: a chunk
    // boundary inside the URL would otherwise yield a partial credential.
    expect(parseAnnouncedWebUrl('dsh web: http://127.0.0.1:3088/?token=ab')).toBe(
      'http://127.0.0.1:3088/?token=ab'
    )
  })
})
