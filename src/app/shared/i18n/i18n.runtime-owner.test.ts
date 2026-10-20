import { describe, expect, it } from 'vitest'
import { createTranslator } from './i18n'
import { RUNTIME_OWNER_ERROR_DETAIL_KEYS, RUNTIME_OWNER_ERROR_MESSAGE_KEYS } from './i18n.errors'

describe('local runtime owner refusal guidance', () => {
  it.each([
    ['managed.runtime_owner_unavailable', '运行所有者暂不可用', 'The runtime owner is unavailable'],
    [
      'managed.runtime_owner_identity_mismatch',
      '运行所有者身份校验失败',
      'Runtime owner identity verification failed'
    ],
    [
      'managed.runtime_owner_record_invalid',
      '运行所有者记录无效',
      'The runtime owner record is invalid'
    ],
    [
      'managed.runtime_owner_protocol_unsupported',
      '运行所有者协议不兼容',
      'The runtime owner protocol is incompatible'
    ],
    [
      'managed.runtime_owner_configuration_invalid',
      '运行所有者配置无效',
      'The runtime owner configuration is invalid'
    ],
    [
      'managed.runtime_owner_shutdown_failed',
      '尚未确认运行所有者已停止',
      'Runtime owner shutdown is not confirmed'
    ]
  ] as const)('explains %s distinctly in both languages', (code, chinese, english) => {
    const title = RUNTIME_OWNER_ERROR_MESSAGE_KEYS[code]
    const detail = RUNTIME_OWNER_ERROR_DETAIL_KEYS[code]
    expect(createTranslator('zh-CN')(title)).toBe(chinese)
    expect(createTranslator('en-US')(title)).toBe(english)
    for (const locale of ['zh-CN', 'en-US'] as const) {
      const remedy = createTranslator(locale)(detail)
      expect(remedy).not.toMatch(/内核未启动|core did not start|checkout is unavailable/i)
      expect(remedy).not.toMatch(/重启 Launcher|restart the Launcher/i)
      expect(remedy.length).toBeGreaterThan(30)
    }
  })

  it('does not claim a stopped process when owner reachability or shutdown is unknown', () => {
    for (const code of [
      'managed.runtime_owner_unavailable',
      'managed.runtime_owner_shutdown_failed'
    ] as const) {
      const detail = RUNTIME_OWNER_ERROR_DETAIL_KEYS[code]
      expect(createTranslator('zh-CN')(detail)).toContain('DSH 可能仍在运行')
      expect(createTranslator('en-US')(detail)).toContain('DSH may still be running')
    }
  })
})
