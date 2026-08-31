export type ProviderCapability = 'chat' | 'image' | 'video' | 'storage' | 'export'

export interface ProviderDefinition {
  id: string
  name: string
  capabilities: ProviderCapability[]
  requiredConfig: string[]
  validateConfig(config: Record<string, unknown>): string[]
  healthCheck?(config: Record<string, unknown>): Promise<boolean>
}

export class ProviderRegistry {
  private readonly providers = new Map<string, ProviderDefinition>()

  register(provider: ProviderDefinition): void {
    if (!provider.id || !/^[a-zA-Z0-9._-]+$/.test(provider.id)) {
      throw new Error('Provider id must be a safe identifier')
    }
    this.providers.set(provider.id, provider)
  }

  get(providerId: string): ProviderDefinition | undefined {
    return this.providers.get(providerId)
  }

  list(): ProviderDefinition[] {
    return Array.from(this.providers.values()).sort((a, b) => a.name.localeCompare(b.name))
  }

  byCapability(capability: ProviderCapability): ProviderDefinition[] {
    return this.list().filter((provider) => provider.capabilities.includes(capability))
  }
}

export const providerRegistry = new ProviderRegistry()

providerRegistry.register({
  id: 'local-example',
  name: 'Local Example Provider',
  capabilities: ['storage', 'export'],
  requiredConfig: [],
  validateConfig: () => []
})
