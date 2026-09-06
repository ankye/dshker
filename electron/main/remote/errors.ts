import type { RemoteConnectionErrorCode } from '../../../src/shared/contracts'

/** Exact remote-connection failure safe to map across the preload boundary. */
export class RemoteConnectionError extends Error {
  constructor(
    readonly code: RemoteConnectionErrorCode,
    message: string,
    readonly details?: { readonly cause?: unknown }
  ) {
    super(message)
    this.name = 'RemoteConnectionError'
  }
}
