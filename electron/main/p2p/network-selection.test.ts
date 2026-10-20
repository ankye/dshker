import { describe, expect, it, vi } from 'vitest'
import { parseNetworkChoices, readNetworkChoices, selectComputerNetwork } from './network-selection'

const serviceId = 'a'.repeat(12)
const pairId = 'b'.repeat(12)
const networkId = 'c'.repeat(12)
const userId = 'd'.repeat(12)
const expectedRevision = 'e'.repeat(64)
function choices() {
  return {
    userId,
    catalogRevision: expectedRevision,
    devices: [
      {
        pairId,
        name: 'My computer',
        selectedNetworkId: '',
        state: 'required',
        choices: [
          { networkId, name: 'Work' },
          { networkId: 'f'.repeat(12), name: 'Home' }
        ]
      }
    ]
  }
}

describe('fresh network choice admission', () => {
  it('copies only exact fresh descriptive choices without selecting the first network', async () => {
    const source = choices()
    const rpc = { call: vi.fn(async () => source) }
    const signal = new AbortController().signal
    const result = await readNetworkChoices(rpc, serviceId, signal)
    expect(rpc.call).toHaveBeenCalledExactlyOnceWith(
      'pairs.network_choices',
      { serviceId, data: {} },
      signal
    )
    expect(result.devices[0].selectedNetworkId).toBe('')
    source.devices[0].choices[0].name = 'Changed after admission'
    expect(result.devices[0].choices[0].name).toBe('Work')
  })

  it('rejects extra credentials, duplicated choices, missing scope and impossible selected states', () => {
    for (const mutate of [
      (value: any) => {
        value.token = 'secret'
      },
      (value: any) => {
        delete value.userId
      },
      (value: any) => {
        value.catalogRevision = 'e'.repeat(12)
      },
      (value: any) => {
        value.devices.push(value.devices[0])
      },
      (value: any) => {
        value.devices[0].choices.push(value.devices[0].choices[0])
      },
      (value: any) => {
        value.devices[0].choices[0].publicKey = 'not renderer data'
      },
      (value: any) => {
        value.devices[0].state = 'selected'
      },
      (value: any) => {
        value.devices[0].selectedNetworkId = networkId
      }
    ]) {
      const value = choices()
      mutate(value)
      expect(() => parseNetworkChoices(value)).toThrow()
    }
  })

  it('sends an exact account/revision/network decision and verifies the authoritative selected result', async () => {
    const selected = choices()
    selected.devices[0].state = 'selected'
    selected.devices[0].selectedNetworkId = networkId
    const rpc = { call: vi.fn(async () => selected) }
    const signal = new AbortController().signal
    const request = { serviceId, pairId, networkId, userId, expectedRevision }
    expect(await selectComputerNetwork(rpc, request, signal)).toEqual(selected)
    expect(rpc.call).toHaveBeenCalledExactlyOnceWith(
      'pairs.select_network',
      {
        serviceId,
        data: { pairId, networkId, userId, expectedRevision }
      },
      signal
    )
    selected.devices[0].selectedNetworkId = 'f'.repeat(12)
    await expect(selectComputerNetwork(rpc, request, signal)).rejects.toThrow(
      'p2p.protocol_mismatch'
    )
    expect(rpc.call).toHaveBeenCalledTimes(2)
  })

  it('keeps a revoked selection explicit even if that network is authorized again', () => {
    const stale = choices()
    stale.devices[0].selectedNetworkId = networkId
    stale.devices[0].state = 'stale'
    expect(parseNetworkChoices(stale).devices[0].state).toBe('stale')
  })
})
