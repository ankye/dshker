import { ipcRenderer } from 'electron'
import {
  P2P_MANAGEMENT_CHANNELS as channels,
  type P2PManagementApi
} from '../src/shared/p2p-management'

/** No general invoke function or helper methods are exposed to a page. */
export const p2pManagement: P2PManagementApi = Object.freeze({
  enable: (request) => ipcRenderer.invoke(channels.enable, request),
  catalog: (request) => ipcRenderer.invoke(channels.catalog, request),
  addService: (request) => ipcRenderer.invoke(channels.addService, request),
  login: (request) => ipcRenderer.invoke(channels.login, request),
  register: (request) => ipcRenderer.invoke(channels.register, request),
  currentUser: (request) => ipcRenderer.invoke(channels.currentUser, request),
  logout: (request) => ipcRenderer.invoke(channels.logout, request),
  networks: (request) => ipcRenderer.invoke(channels.networks, request),
  createNetwork: (request) => ipcRenderer.invoke(channels.createNetwork, request),
  renameNetwork: (request) => ipcRenderer.invoke(channels.renameNetwork, request),
  updateNetworkLimit: (request) => ipcRenderer.invoke(channels.updateNetworkLimit, request),
  deleteNetwork: (request) => ipcRenderer.invoke(channels.deleteNetwork, request),
  registration: (request) => ipcRenderer.invoke(channels.registration, request),
  registerDevice: (request) => ipcRenderer.invoke(channels.registerDevice, request),
  joinNetwork: (request) => ipcRenderer.invoke(channels.joinNetwork, request),
  leaveNetwork: (request) => ipcRenderer.invoke(channels.leaveNetwork, request),
  submitEnrollment: (request) => ipcRenderer.invoke(channels.submitEnrollment, request),
  recoverEnrollment: (request) => ipcRenderer.invoke(channels.recoverEnrollment, request),
  pairs: (request) => ipcRenderer.invoke(channels.pairs, request),
  pairIdentity: (request) => ipcRenderer.invoke(channels.pairIdentity, request),
  createInvite: (request) => ipcRenderer.invoke(channels.createInvite, request),
  acceptInvite: (request) => ipcRenderer.invoke(channels.acceptInvite, request),
  approvePair: (request) => ipcRenderer.invoke(channels.approvePair, request),
  rejectPair: (request) => ipcRenderer.invoke(channels.rejectPair, request),
  revokePair: (request) => ipcRenderer.invoke(channels.revokePair, request),
  removeService: (request) => ipcRenderer.invoke(channels.removeService, request),
  connections: (request) => ipcRenderer.invoke(channels.connections, request),
  updateServiceConfig: (request) => ipcRenderer.invoke(channels.updateServiceConfig, request),
  remoteRoots: (request) => ipcRenderer.invoke(channels.remoteRoots, request),
  remoteDirectory: (request) => ipcRenderer.invoke(channels.remoteDirectory, request),
  connect: (request) => ipcRenderer.invoke(channels.connect, request),
  disconnect: (request) => ipcRenderer.invoke(channels.disconnect, request),
  cancel: (request) => ipcRenderer.invoke(channels.cancel, request)
})
