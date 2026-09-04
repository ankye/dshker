import packageJson from '../../package.json'
import { APP_METADATA } from './contracts'

describe('application metadata', () => {
  it('uses the package version as the compiled runtime version', () => {
    expect(APP_METADATA.version).toBe(packageJson.version)
  })
})
