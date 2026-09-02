import { describe, expect, it } from 'vitest'
import { APPLICATION_ROUTES, findApplicationRoute } from './routes'

describe('launcher navigation', () => {
  it('keeps the primary launcher workflow in sidebar order', () => {
    expect(APPLICATION_ROUTES.map((route) => route.id)).toEqual([
      'launch',
      'advanced',
      'versions',
      'controller',
      'usage',
      'settings',
      'runtime'
    ])
  })

  it('does not infer an unknown route', () => {
    expect(findApplicationRoute('launch')).toMatchObject({ id: 'launch' })
    expect(findApplicationRoute('missing' as never)).toBeUndefined()
  })

  it('assigns a unique icon to every sidebar entry', () => {
    const icons = APPLICATION_ROUTES.map((route) => route.icon)
    expect(icons).toHaveLength(new Set(icons).size)
    for (const route of APPLICATION_ROUTES) {
      expect(route.icon, route.id).toBeTruthy()
    }
  })
})
