/** Local and branch builds are test applications unless a stable build is requested explicitly. */
export function distributionChannel(environment = process.env) {
  const channel = environment.DSHKER_DISTRIBUTION_CHANNEL ?? 'test'
  if (channel !== 'stable' && channel !== 'test')
    throw new Error('Invalid DSHKER_DISTRIBUTION_CHANNEL')
  return channel
}

/** Test installers have independent OS registration, process names and update artifacts. */
export function distributionIdentity(packageJson, channel) {
  if (channel !== 'stable' && channel !== 'test') throw new Error('Invalid distribution channel')
  const appId = packageJson.build?.appId || packageJson.name
  const productName = packageJson.build?.productName || packageJson.name
  return channel === 'test'
    ? { appId: `${appId}.test`, productName: `${productName} Test` }
    : { appId, productName }
}

export function distributionBuildConfiguration(packageJson, channel) {
  const identity = distributionIdentity(packageJson, channel)
  const base = packageJson.build
  return {
    ...base,
    ...identity,
    nsis: {
      ...base.nsis,
      installerLanguages: ['en_US', 'zh_CN'],
      include: 'resources/installer-preserve-runtime.nsh'
    },
    ...(channel === 'test'
      ? {
          artifactName: 'dshker-launcher-test-${version}-${os}-${arch}.${ext}',
          linux: { ...base.linux, executableName: 'dshker-launcher-test' }
        }
      : {}),
    extraMetadata: { ...base.extraMetadata, dshkerDistributionChannel: channel }
  }
}
