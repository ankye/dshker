import { describe, expect, it } from 'vitest'
import { createDomainCommand, createDomainEvent } from './domainMessages'

describe('domain messages', () => {
  it('creates typed events and commands with stable metadata', () => {
    expect(
      createDomainEvent(
        {
          name: 'asset.imported',
          source: 'asset-library',
          payload: { resourceId: 'imports:hero.png' }
        },
        { id: 'evt-1', nowMs: 1000 }
      )
    ).toEqual({
      id: 'evt-1',
      kind: 'event',
      name: 'asset.imported',
      source: 'asset-library',
      payload: { resourceId: 'imports:hero.png' },
      createdAtMs: 1000
    })

    expect(
      createDomainCommand(
        {
          name: 'render.enqueue',
          source: 'asset-library',
          target: 'render-queue',
          payload: { resourceId: 'imports:hero.png' }
        },
        { id: 'cmd-1', nowMs: 2000 }
      )
    ).toMatchObject({
      id: 'cmd-1',
      kind: 'command',
      name: 'render.enqueue',
      source: 'asset-library',
      target: 'render-queue',
      createdAtMs: 2000
    })
  })
})
