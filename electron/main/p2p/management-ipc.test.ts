import { EventEmitter } from 'node:events'
import type { IpcMainInvokeEvent } from 'electron'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import {
  P2P_MANAGEMENT_CHANNELS as channels,
  type P2PManagementOperation
} from '../../../src/shared/p2p-management'
import { registerPeerManagementIpc, type PeerManagementOwner } from './management-ipc'
import { parseManagementRequest } from './management-admission'
import { PeerHelperError } from './wire'

const mocks = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>() }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: any[]) => any) =>
      mocks.handlers.set(channel, handler)
  },
  BrowserWindow: { fromWebContents: (sender: { owned: boolean }) => (sender.owned ? {} : null) },
  app: {},
  Menu: {}
}))

const serviceId = 'a'.repeat(64)
const networkId = 'b'.repeat(32)
const revision = 'c'.repeat(64)
const pairId = '9'.repeat(32)
/** Grouped-hex form the UI displays and the user confirms. */
const fingerprint = ['1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888'].join(' ')
const inputs: Record<P2PManagementOperation, Record<string, unknown>> = {
  enable: {},
  catalog: {},
  addService: {
    revision,
    displayName: 'Home',
    httpsOrigin: 'https://peer.example',
    wssUrl: 'wss://peer.example/v1/signals',
    stunAddress: 'peer.example:3478'
  },
  login: { serviceId, username: 'alice', password: 'secret-login-password' },
  register: { serviceId, email: 'alice@example.com', password: 'secret-register-password' },
  currentUser: { serviceId },
  logout: { serviceId },
  networks: { serviceId },
  createNetwork: { serviceId, name: 'Office' },
  renameNetwork: { serviceId, networkId, name: 'Office' },
  updateNetworkLimit: { serviceId, networkId, maxDevices: 20 },
  deleteNetwork: { serviceId, networkId },
  registration: { serviceId },
  registerDevice: { serviceId, networkId, name: 'Mac' },
  joinNetwork: { serviceId, networkId, name: 'Mac' },
  leaveNetwork: { serviceId, networkId, deviceId: 'e'.repeat(32) },
  submitEnrollment: { serviceId, revision },
  recoverEnrollment: { serviceId, revision },
  pairs: { serviceId },
  pairIdentity: { serviceId, pairId },
  createInvite: { serviceId, networkId },
  acceptInvite: { serviceId, networkId, code: 'ABCDEFGHIJKLMNOP' },
  approvePair: { serviceId, pairId, fingerprint },
  rejectPair: { serviceId, pairId },
  revokePair: { serviceId, pairId },
  removeService: { serviceId },
  connections: {},
  connect: { serviceId, pairId },
  disconnect: { serviceId, pairId },
  localDevice: {},
  updateServiceConfig: {
    serviceId,
    revision,
    displayName: 'Home',
    httpsOrigin: 'https://peer.example',
    wssUrl: 'wss://peer.example/v1/signals',
    stunAddress: 'peer.example:3478'
  },
  remoteRoots: { serviceId, pairId },
  remoteDirectory: { serviceId, pairId, rootId: 'root-a', ref: '', offset: 0, limit: 50 },
  cancel: { targetRequestId: 1 }
}
function request(method: P2PManagementOperation, requestId = 1) {
  return { version: 1, requestId, ...inputs[method] }
}
function page() {
  const sender = Object.assign(new EventEmitter(), {
    owned: true,
    mainFrame: { url: 'dsh-app://launcher/index.html' },
    isDestroyed: () => false
  })
  return {
    sender,
    event: { sender, senderFrame: sender.mainFrame } as unknown as IpcMainInvokeEvent
  }
}
function fixture() {
  const user = { userId: 'd'.repeat(32), username: 'alice' }
  const network = { userId: user.userId, networkId, name: 'Office', maxDevices: 10 }
  const registration = {
    kind: 'registered' as const,
    serviceId,
    deviceId: 'e'.repeat(32),
    userId: user.userId,
    name: 'Mac',
    publicKey: 'public-key',
    revision
  }
  const snapshot = {
    revision,
    record: {
      format: 'dshker.p2p-devices' as const,
      version: 1 as const,
      catalogId: 'f'.repeat(32),
      services: [
        { ...inputs.addService, serviceId, publicKey: 'public-key', certificate: 'must-not-leak' }
      ],
      computers: [],
      forgottenServiceIds: []
    }
  }
  const pairDevice = (deviceId: string, presence: 'online' | 'offline') => ({
    deviceId,
    userId: user.userId,
    name: `dev-${deviceId.slice(0, 4)}`,
    fingerprint,
    presence
  })
  const pair = {
    pairId,
    networkId,
    state: 'active' as const,
    revision: 4,
    expiresAt: 1_800_000_000,
    initiator: pairDevice('1'.repeat(32), 'online'),
    target: pairDevice('2'.repeat(32), 'offline'),
    localIsInitiator: true
  }
  const invite = { code: 'ABCDEFGHIJKLMNOP', networkId, expiresAt: 1_800_000_000 }
  const helperState = {
    pairId,
    attemptId: '7'.repeat(32),
    generation: 5,
    stage: 'ready' as const,
    error: '',
    path: { localType: 'host', remoteType: 'srflx', protocol: 'udp' },
    runtimeGeneration: 2
  }
  const owner = {
    enable: vi.fn(async () => snapshot),
    catalog: vi.fn(async () => snapshot),
    addService: vi.fn(async () => snapshot),
    login: vi.fn(async () => user),
    currentUser: vi.fn(async () => user),
    logout: vi.fn(async () => undefined),
    networks: vi.fn(async () => [network]),
    createNetwork: vi.fn(async () => network),
    renameNetwork: vi.fn(async () => network),
    deleteNetwork: vi.fn(async () => undefined),
    registration: vi.fn(async () => registration),
    registerDevice: vi.fn(async () => registration),
    submitEnrollment: vi.fn(async () => registration),
    recoverEnrollment: vi.fn(async () => registration),
    pairs: vi.fn(async () => [pair]),
    pairIdentity: vi.fn(async () => pair),
    createInvite: vi.fn(async () => invite),
    acceptInvite: vi.fn(async () => pair),
    approvePair: vi.fn(async () => pair),
    rejectPair: vi.fn(async () => pair),
    revokePair: vi.fn(async () => snapshot),
    removeService: vi.fn(async () => snapshot),
    connections: vi.fn(() => ({ error: '', peers: [{ serviceId, state: helperState }] })),
    connect: vi.fn(async () => helperState),
    disconnect: vi.fn(async () => undefined),
    localDevice: vi.fn(async () => ({ deviceId: 'a'.repeat(32), name: 'host' })),
    updateServiceConfig: vi.fn(async () => snapshot),
    remoteRoots: vi.fn(async () => [{ rootId: 'root-a', name: 'Work', path: '/remote/work' }]),
    remoteDirectory: vi.fn(async () => ({
      entries: [{ ref: 'abc', name: 'alpha', isDirectory: true, isProject: true }],
      total: 1
    }))
  }
  registerPeerManagementIpc(owner as unknown as PeerManagementOwner)
  const invoke = (
    method: P2PManagementOperation,
    event: IpcMainInvokeEvent,
    value: unknown,
    ...extra: unknown[]
  ) => mocks.handlers.get(channels[method])!(event, value, ...extra)
  return { owner, invoke, user, network, registration }
}

beforeEach(() => {
  mocks.handlers.clear()
  vi.stubEnv('ELECTRON_RENDERER_URL', '')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('P2P named management admission', () => {
  it.each(Object.keys(channels) as P2PManagementOperation[])(
    '%s admits only its exact versioned fields before owner access',
    async (method) => {
      const { owner, invoke } = fixture()
      expect(parseManagementRequest(method, request(method))).toEqual(request(method))
      for (const field of [
        'privateKey',
        'token',
        'certificate',
        'path',
        'executable',
        'sdp',
        'url',
        'deviceId',
        'pinnedKey',
        'payload'
      ]) {
        const result = await invoke(method, page().event, {
          ...request(method),
          [field]: 'forbidden'
        })
        expect(result.ok).toBe(false)
      }
      for (const value of [
        null,
        {},
        { ...request(method), version: 2 },
        { ...request(method), requestId: 0 },
        { ...request(method), requestId: 1.5 }
      ]) {
        expect((await invoke(method, page().event, value)).ok).toBe(false)
      }
      expect((await invoke(method, page().event, request(method), 'extra')).code).toBe(
        'p2p.invalid_request'
      )
      for (const handler of Object.values(owner)) expect(handler).not.toHaveBeenCalled()
    }
  )

  it.each(Object.keys(channels) as P2PManagementOperation[])(
    '%s rejects foreign windows, subframes and origins using production sender policy',
    async (method) => {
      const { owner, invoke } = fixture()
      const foreign = page()
      foreign.sender.owned = false
      const subframe = page()
      Object.assign(subframe.event, {
        senderFrame: {
          url: 'dsh-app://launcher/index.html'
        }
      })
      const external = page()
      external.sender.mainFrame.url = 'https://peer.example/'
      for (const candidate of [foreign, subframe, external]) {
        expect((await invoke(method, candidate.event, request(method))).code).toBe(
          'p2p.ipc_invalid_sender'
        )
      }
      for (const handler of Object.values(owner)) expect(handler).not.toHaveBeenCalled()
    }
  )

  it('routes every management operation to its named owner with precise primitive arguments', async () => {
    const { owner, invoke, user, network, registration } = fixture()
    const { event } = page()
    let sequence = 0
    for (const method of Object.keys(owner) as Exclude<
      P2PManagementOperation,
      'cancel' | 'register' | 'updateNetworkLimit' | 'joinNetwork' | 'leaveNetwork'
    >[]) {
      const result = await invoke(method, event, request(method, ++sequence))
      expect(result.ok, method).toBe(true)
      expect(owner[method]).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(result)).not.toContain('must-not-leak')
      expect(JSON.stringify(result)).not.toContain('secret-login-password')
      if (method === 'login' || method === 'currentUser') expect(result.data).toEqual(user)
      if (method === 'createNetwork' || method === 'renameNetwork')
        expect(result.data).toEqual(network)
      if (method === 'networks') expect(result.data).toEqual([network])
      if (
        ['registration', 'registerDevice', 'submitEnrollment', 'recoverEnrollment'].includes(method)
      )
        expect(result.data).toEqual(registration)
    }
    const signal = expect.any(AbortSignal)
    expect(owner.login).toHaveBeenCalledWith(serviceId, 'alice', 'secret-login-password', signal)
    expect(owner.renameNetwork).toHaveBeenCalledWith(serviceId, networkId, 'Office', signal)
    expect(owner.registerDevice).toHaveBeenCalledWith(serviceId, networkId, 'Mac', signal)
    expect(owner.submitEnrollment).toHaveBeenCalledWith(serviceId, revision, signal)
    expect(owner.recoverEnrollment).toHaveBeenCalledWith(serviceId, revision, signal)
    expect(owner.addService).toHaveBeenCalledWith(
      revision,
      {
        displayName: 'Home',
        httpsOrigin: 'https://peer.example',
        wssUrl: 'wss://peer.example/v1/signals',
        stunAddress: 'peer.example:3478'
      },
      signal
    )
  })

  it('rejects credential/ID/text/endpoint boundaries and snapshots accepted input', () => {
    for (const value of ['', 'x'.repeat(73)])
      expect(() =>
        parseManagementRequest('login', { ...request('login'), password: value })
      ).toThrow()
    expect(
      parseManagementRequest('login', { ...request('login'), password: ' password ' }).password
    ).toBe(' password ')
    for (const [method, field, value] of [
      ['login', 'username', 'x'],
      ['currentUser', 'serviceId', 'a'],
      ['registerDevice', 'networkId', ''],
      ['createNetwork', 'name', ' bad '],
      ['submitEnrollment', 'revision', ''],
      ['addService', 'httpsOrigin', 'http://peer.example'],
      ['addService', 'wssUrl', 'ws://peer.example/v1/signal'],
      ['addService', 'stunAddress', '']
    ] as const)
      expect(() => parseManagementRequest(method, { ...request(method), [field]: value })).toThrow()
    const draft = request('addService')
    const admitted = parseManagementRequest('addService', draft)
    Object.assign(draft, { displayName: 'changed', privateKey: 'injected' })
    expect(admitted.displayName).toBe('Home')
    expect(admitted).not.toHaveProperty('privateKey')
  })

  it('refuses register at dispatch until the helper exposes the user.register RPC', async () => {
    const { invoke } = fixture()
    const result = await invoke('register', page().event, request('register'))
    expect(result).toEqual({
      ok: false,
      code: 'p2p.invalid_operation',
      message: 'p2p.invalid_operation'
    })
  })

  it('returns only allowlisted errors and never exception or helper text', async () => {
    const { owner, invoke } = fixture()
    for (const [error, expected] of [
      [new Error('secret-password /private/location'), 'p2p.internal_error'],
      [new PeerHelperError('p2p.secret_from_helper'), 'p2p.internal_error'],
      [new PeerHelperError('p2p.user_unauthorized'), 'p2p.user_unauthorized']
    ] as const) {
      owner.catalog.mockRejectedValueOnce(error)
      expect(await invoke('catalog', page().event, request('catalog'))).toEqual({
        ok: false,
        code: expected,
        message: expected
      })
    }
  })

  it('routes cancellation to the exact pending IPC request and preserves write uncertainty', async () => {
    const { owner, invoke } = fixture()
    let finish!: () => void
    let active!: AbortSignal
    Object.assign(owner, {
      deleteNetwork: vi.fn((_service: string, _network: string, signal: AbortSignal) => {
        active = signal
        return new Promise<void>((resolve) => {
          finish = resolve
        })
      })
    })
    const a = page(),
      b = page()
    const deletion = invoke('deleteNetwork', a.event, request('deleteNetwork'))
    expect((await invoke('cancel', b.event, request('cancel'))).code).toBe(
      'p2p.request_unavailable'
    )
    expect(active.aborted).toBe(false)
    expect(await invoke('cancel', a.event, request('cancel', 2))).toEqual({
      ok: true,
      data: { accepted: true }
    })
    expect(active.aborted).toBe(true)
    finish()
    expect((await deletion).code).toBe('p2p.management_result_unconfirmed')
    expect(owner.deleteNetwork).toHaveBeenCalledTimes(1)
  })

  it('represents never-enabled state explicitly without inventing an empty catalog', async () => {
    const { owner, invoke } = fixture()
    Object.assign(owner, { catalog: vi.fn(async () => undefined) })
    expect(await invoke('catalog', page().event, request('catalog'))).toEqual({
      ok: true,
      data: null
    })
    expect(owner.enable).not.toHaveBeenCalled()
  })
})
