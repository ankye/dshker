// @vitest-environment node
import { readFile } from 'node:fs/promises'
import {
  distributionBuildConfiguration,
  distributionChannel,
  distributionIdentity
} from './distribution-channel.mjs'

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

describe('desktop distribution identity', () => {
  it('defaults local builds to test and accepts only explicit stable or test selection', () => {
    expect(distributionChannel({})).toBe('test')
    expect(distributionChannel({ DSHKER_DISTRIBUTION_CHANNEL: 'stable' })).toBe('stable')
    expect(() => distributionChannel({ DSHKER_DISTRIBUTION_CHANNEL: 'production' })).toThrow(
      'Invalid'
    )
  })

  it('keeps stable OS identity and gives test installers independent process and application identities', () => {
    const stable = distributionBuildConfiguration(packageJson, 'stable')
    const test = distributionBuildConfiguration(packageJson, 'test')
    expect(stable.appId).toBe(packageJson.build.appId)
    expect(stable.productName).toBe(packageJson.build.productName)
    expect(test.appId).toBe(`${stable.appId}.test`)
    expect(test.productName).toBe(`${stable.productName} Test`)
    expect(test.artifactName).toContain('launcher-test-')
    expect(test.linux.executableName).not.toBe(stable.linux.executableName)
    expect(stable.extraMetadata.dshkerDistributionChannel).toBe('stable')
    expect(test.extraMetadata.dshkerDistributionChannel).toBe('test')
    expect(test.extraMetadata.name).toBeUndefined()
    expect(test.extraMetadata.productName).toBeUndefined()
    expect(stable.nsis.include).toBe('resources/installer-preserve-runtime.nsh')
    expect(test.nsis.include).toBe(stable.nsis.include)
    expect(stable.nsis.installerLanguages).toEqual(['en_US', 'zh_CN'])
    expect(test.nsis.installerLanguages).toEqual(stable.nsis.installerLanguages)
    expect(distributionIdentity(packageJson, 'test').appId).toBe(test.appId)
    expect(() => distributionIdentity(packageJson, 'other')).toThrow('Invalid')
  })

  it('uses an observation-only installer guard without process termination or directory-string interpolation', async () => {
    const include = await readFile(
      new URL('../resources/installer-preserve-runtime.nsh', import.meta.url),
      'utf8'
    )
    expect(include).toContain('!macro customCheckAppRunning')
    expect(include).toContain('DSHKER_INSTALL_GUARD_ROOT')
    expect(include).toContain('$$_.ProcessId -ne $$own')
    expect(include).toContain('StartsWith($$prefix,[StringComparison]::OrdinalIgnoreCase)')
    expect(include).toContain('MB_RETRYCANCEL')
    expect(include).not.toMatch(/Stop-Process|taskkill|TerminateProcess|KILL_PROCESS/u)
  })

  it('routes every desktop packaging command through the channel configuration', () => {
    for (const [name, command] of Object.entries(packageJson.scripts)) {
      if (name === 'package' || name === 'dist' || name.startsWith('dist:')) {
        expect(command).toContain('electron-builder --config tools/electron-builder.config.mjs')
      }
    }
  })
})
