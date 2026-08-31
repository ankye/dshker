import {
  apiFail,
  type ApiResult,
  type BootstrapErrorCode,
  type BootstrapInfo,
  type DesktopApi
} from '../shared/contracts'

/**
 * Reads the immutable app identity from the admitted preload capability.
 * Browser preview deliberately stays blocked because it has no native bridge.
 */
export async function getBootstrapInfo(
  desktopApi: DesktopApi | undefined = window.dshLauncher
): Promise<ApiResult<BootstrapInfo, BootstrapErrorCode>> {
  if (!desktopApi) {
    return apiFail(
      'bootstrap.bridge_unavailable',
      'The DSH Launcher desktop bridge is unavailable.'
    )
  }

  return desktopApi.bootstrap.getInfo()
}
