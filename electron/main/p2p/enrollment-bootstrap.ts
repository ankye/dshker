import type { PeerCredentialStore } from './credentials'

/** One network as the enrollment policy needs to see it. */
export interface EnrollmentNetwork {
  readonly networkId: string
}

/**
 * What enrolling a signed-in machine needs from its owner.
 *
 * A narrow seam on purpose: the policy lives here, while the session, the network
 * list and the enrollment call stay with the manager that owns them.
 */
export interface EnrollmentHost {
  readonly credentials: Pick<PeerCredentialStore, 'loadRegistration' | 'loadUserSession'>
  /** Brings the service up and restores the signed-in account, if there is one. */
  readonly signIn: (serviceId: string, signal: AbortSignal) => Promise<boolean>
  /** The networks this account owns, creating one when it has none. */
  readonly networks: (
    serviceId: string,
    signal: AbortSignal
  ) => Promise<readonly EnrollmentNetwork[]>
  readonly createNetwork: (serviceId: string, signal: AbortSignal) => Promise<EnrollmentNetwork>
  readonly register: (serviceId: string, networkId: string, name: string) => Promise<unknown>
}

/**
 * Enrolls this machine when the account is signed in and no device identity is
 * stored.
 *
 * A signed-in account with no credential reaches nothing: the peer sees a
 * computer that never identifies itself, and reconnecting cannot change that,
 * because connecting is not what creates an identity -- enrollment is. A
 * credential that is not there is created, never migrated, and the network it
 * joins is one the account already owns.
 *
 * @returns whether this machine now has a device identity.
 */
export async function enrollWhenMissing(
  host: EnrollmentHost,
  serviceId: string,
  name: string,
  signal: AbortSignal
): Promise<boolean> {
  const stored = await host.credentials.loadRegistration(serviceId).catch(() => undefined)
  if (stored?.kind === 'registered') return true
  if (!(await host.signIn(serviceId, signal))) return false
  const owned = await host.networks(serviceId, signal)
  const network = owned[0] ?? (await host.createNetwork(serviceId, signal))
  await host.register(serviceId, network.networkId, name)
  return true
}
