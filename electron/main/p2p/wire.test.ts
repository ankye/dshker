import { describe, expect, it } from 'vitest'
import { decodePeerFrame, parsePeerJson } from './wire'

describe('private peer wire admission', () => {
  it('retains nested identity fields and Unicode without coercion', () => {
    const payload = { name: '电脑 A', nested: [{ generation: 9, available: false }] }
    const frame = { version: 1, id: 7, method: '', payload, error: '' }
    expect(decodePeerFrame(JSON.stringify(frame))).toEqual(frame)
  })

  it.each([
    '{"a":1,"a":2}',
    '{"a":1,"\\u0061":2}',
    '{"nested":{"key":1,"key":2}}',
    '{"a":null}',
    '{"a":1e999}',
    '{"a":01}',
    '{"a":1,}',
    '{"a":[1,]}',
    '{}{}',
    '{"a":undefined}',
    '{"a":NaN}',
    '{"a":"\\x00"}'
  ])('rejects ambiguous JSON %s', (value) => {
    expect(() => parsePeerJson(value)).toThrow('p2p.protocol_mismatch')
  })

  it.each([
    { version: 2 },
    { id: 0 },
    { id: 1.5 },
    { id: Number.MAX_SAFE_INTEGER + 1 },
    { method: 'a'.repeat(81) },
    { error: 'private credential' },
    { payload: null },
    { extra: true }
  ])('rejects invalid frame fields %o', (patch) => {
    expect(() =>
      decodePeerFrame(
        JSON.stringify({ version: 1, id: 1, method: '', payload: {}, error: '', ...patch })
      )
    ).toThrow('p2p.protocol_mismatch')
  })

  it('rejects excess depth and missing required fields', () => {
    expect(() => parsePeerJson('['.repeat(14) + '0' + ']'.repeat(14))).toThrow()
    expect(() => decodePeerFrame('{"version":1,"id":1,"method":"","payload":{}}')).toThrow()
  })
})
