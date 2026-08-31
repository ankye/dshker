import { describe, expect, it } from 'vitest'
import { ProviderRegistry } from './providers'

describe('provider registry', () => {
  it('registers and filters providers by capability', () => {
    const registry = new ProviderRegistry()
    registry.register({
      id: 'exporter',
      name: 'Exporter',
      capabilities: ['export'],
      requiredConfig: [],
      validateConfig: () => []
    })

    expect(registry.get('exporter')?.name).toBe('Exporter')
    expect(registry.byCapability('export')).toHaveLength(1)
    expect(registry.byCapability('video')).toHaveLength(0)
  })

  it('rejects unsafe provider ids', () => {
    const registry = new ProviderRegistry()
    expect(() =>
      registry.register({
        id: '../bad',
        name: 'Bad',
        capabilities: [],
        requiredConfig: [],
        validateConfig: () => []
      })
    ).toThrow('Provider id must be a safe identifier')
  })
})
