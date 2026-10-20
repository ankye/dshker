import { describe, expect, it } from 'vitest'
import { createTranslator } from './i18n'

describe('suspended connection copy', () => {
  it('describes recovery without claiming ready or a terminal failure in both languages', () => {
    expect(createTranslator('zh-CN')('p2p.connection.stageSuspended')).toBe('连接中断，正在恢复…')
    expect(createTranslator('en-US')('p2p.connection.stageSuspended')).toBe(
      'Connection interrupted — recovering...'
    )
  })
})
