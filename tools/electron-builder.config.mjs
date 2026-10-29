import { readFileSync } from 'node:fs'
import { distributionBuildConfiguration, distributionChannel } from './distribution-channel.mjs'

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
export default distributionBuildConfiguration(packageJson, distributionChannel())
