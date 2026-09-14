// The main-only view of the core's checkout layer.
//
// The shell used to own Harness checkout management: it pinned git, derived the
// managed paths, drove the mirror and materialized worktrees itself. As of 4.2 it
// asks the core for one operation and receives a verified identity, which is what
// it persists into the installation catalog. No path, commit or remote reaches the
// renderer through this port.
import type { PeerRpc } from '../p2p/rpc'
import { PeerHelperError } from '../p2p/wire'

/** The wire shape of one pinned git executable, as the catalog stores it. */
export interface CoreGitRegistration {
  readonly requestedPath: string
  readonly canonicalPath: string
  readonly fingerprint: {
    readonly device: number
    readonly inode: number
    readonly size: number
    readonly modifiedAtMilliseconds: number
  }
  readonly version: {
    readonly major: number
    readonly minor: number
    readonly patch: number
    readonly text: string
  }
}

/** One named remote with its separately validated source identity. */
export interface CoreNamedRemote {
  readonly name: string
  readonly source: {
    readonly declaredUrl: string
    readonly identity: {
      readonly transport: 'https' | 'ssh'
      readonly host: string
      readonly effectivePort: number
      readonly sshUser?: string
      readonly repositoryPathKind: 'absolute' | 'relative'
      readonly repositoryPath: string
      readonly display: string
    }
  }
}

/** One branch, tag or exact commit, as the core validates it. */
export interface CoreRevisionSelection {
  readonly kind: 'branch' | 'tag' | 'commit'
  readonly branch?: string
  readonly tag?: string
  readonly commit?: string
}

/** What the installation recorded for a mutable reference the last time it was used. */
export interface CoreReferenceObservation {
  readonly selection: CoreRevisionSelection
  readonly commit: string
  readonly observedObject: string
}

/** The verified identity the shell persists. */
export interface CoreCheckoutView {
  readonly installationPath: string
  readonly mirrorPath: string
  readonly worktreePath: string
  readonly commit: string
  readonly remote: CoreNamedRemote
  readonly selection: CoreRevisionSelection
  readonly observedReference: string
  readonly observedObject: string
  readonly tagObject: string
}

/** The read-only observation of a user-owned repository. */
export interface CoreRepositoryInspection {
  readonly canonicalPath: string
  readonly head: string
  readonly remote: CoreNamedRemote['source']['identity']
  readonly dirtyEntries: readonly string[]
}

export interface CoreCheckoutPort {
  gitRegister(request: CoreGitRegisterRequest, signal?: AbortSignal): Promise<CoreGitRegistration>
  repositoryInspect(
    request: CoreRepositoryInspectRequest,
    signal?: AbortSignal
  ): Promise<CoreRepositoryInspection>
  prepare(request: CoreCheckoutPrepareRequest, signal?: AbortSignal): Promise<CoreCheckoutView>
  verify(request: CoreCheckoutVerifyRequest, signal?: AbortSignal): Promise<CoreCheckoutView>
}

export interface CoreGitRegisterRequest {
  readonly executablePath: string
  readonly workingDirectory: string
  readonly minimum: {
    readonly major: number
    readonly minor: number
    readonly patch: number
    readonly text: string
  }
  readonly maximumExclusive: {
    readonly major: number
    readonly minor: number
    readonly patch: number
    readonly text: string
  }
}

export interface CoreRepositoryInspectRequest {
  readonly repositoryPath: string
  readonly remote: CoreNamedRemote
  readonly git: CoreGitRegistration
}

export interface CoreCheckoutPrepareRequest {
  readonly namespacePath: string
  readonly installationId: string
  readonly remote: CoreNamedRemote
  readonly git: CoreGitRegistration
  readonly bundlePath: string
  readonly selection: CoreRevisionSelection
  readonly previous: CoreReferenceObservation
}

export interface CoreCheckoutVerifyRequest {
  readonly namespacePath: string
  readonly installationId: string
  readonly remote: CoreNamedRemote
  readonly git: CoreGitRegistration
  readonly commit: string
}

const CALL_BUDGET_MS = 600_000

function budget(signal?: AbortSignal): AbortSignal {
  return signal ?? AbortSignal.timeout(CALL_BUDGET_MS)
}

function recordOf(value: unknown, key: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PeerHelperError('p2p.invalid_payload')
  }
  const answer = value as Record<string, unknown>
  const inner = answer[key]
  if (typeof inner !== 'object' || inner === null || Array.isArray(inner)) {
    throw new PeerHelperError('p2p.invalid_payload')
  }
  return inner as Record<string, unknown>
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const field = value[key]
  if (typeof field !== 'string' || field.length === 0)
    throw new PeerHelperError('p2p.invalid_payload')
  return field
}

/** Projects one core answer through the same shape rules the catalog record uses. */
function checkoutOf(value: unknown): CoreCheckoutView {
  const checkout = recordOf(value, 'checkout')
  const remote = checkout.remote
  if (typeof remote !== 'object' || remote === null || Array.isArray(remote)) {
    throw new PeerHelperError('p2p.invalid_payload')
  }
  return {
    installationPath: requiredString(checkout, 'installationPath'),
    mirrorPath: requiredString(checkout, 'mirrorPath'),
    worktreePath: requiredString(checkout, 'worktreePath'),
    commit: requiredString(checkout, 'commit'),
    remote: remote as CoreNamedRemote,
    selection: checkout.selection as CoreRevisionSelection,
    observedReference:
      typeof checkout.observedReference === 'string' ? checkout.observedReference : '',
    observedObject: typeof checkout.observedObject === 'string' ? checkout.observedObject : '',
    tagObject: typeof checkout.tagObject === 'string' ? checkout.tagObject : ''
  }
}

function registrationOf(value: unknown): CoreGitRegistration {
  return recordOf(value, 'registration') as unknown as CoreGitRegistration
}

function inspectionOf(value: unknown): CoreRepositoryInspection {
  return recordOf(value, 'inspection') as unknown as CoreRepositoryInspection
}

/** Calls the managed.* checkout methods of a live dshkerd over its private channel. */
export class CoreCheckoutClient implements CoreCheckoutPort {
  readonly #rpc: Pick<PeerRpc, 'call'>

  constructor(rpc: Pick<PeerRpc, 'call'>) {
    this.#rpc = rpc
  }

  async gitRegister(
    request: CoreGitRegisterRequest,
    signal?: AbortSignal
  ): Promise<CoreGitRegistration> {
    return registrationOf(await this.#rpc.call('managed.git_register', request, budget(signal)))
  }

  async repositoryInspect(
    request: CoreRepositoryInspectRequest,
    signal?: AbortSignal
  ): Promise<CoreRepositoryInspection> {
    return inspectionOf(await this.#rpc.call('managed.repository_inspect', request, budget(signal)))
  }

  async prepare(
    request: CoreCheckoutPrepareRequest,
    signal?: AbortSignal
  ): Promise<CoreCheckoutView> {
    return checkoutOf(await this.#rpc.call('managed.checkout_prepare', request, budget(signal)))
  }

  async verify(
    request: CoreCheckoutVerifyRequest,
    signal?: AbortSignal
  ): Promise<CoreCheckoutView> {
    return checkoutOf(await this.#rpc.call('managed.checkout_verify', request, budget(signal)))
  }
}
