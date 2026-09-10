import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * Guards the visual hierarchy of the remote-connection panels.
 *
 * These regressions were invisible to the existing gates: visual-smoke audits
 * only the global stylesheets, so component-scoped styles were never checked,
 * and every rendering test asserted behavior rather than presentation. The
 * account and enrollment cards had drifted into flat, uniform-weight text where
 * a raw user ID competed with the account name and a secondary refresh button
 * stretched to the full card width, reading as the primary action.
 */
const appRoot = path.resolve(import.meta.dirname, '../../../..')

async function componentSource(name: string): Promise<string> {
  return readFile(path.join(appRoot, 'src/app/shell/components', name), 'utf8')
}

describe('remote connection visual hierarchy', () => {
  it('keeps the native select out of the account panel', async () => {
    // ThemedListbox exists because the native popup cannot carry the dark
    // operational palette, which the workspace design gate forbids.
    const source = await componentSource('P2PAccountPanel.vue')
    expect(source).not.toMatch(/<select\b/u)
    expect(source).toContain('ThemedListbox')
  })

  it('does not stretch a secondary refresh action across the card', async () => {
    const source = await componentSource('P2PAccountPanel.vue')
    expect(source).toMatch(/\.p2p-account-refresh\s*\{[^}]*justify-self:\s*start/u)
  })

  it('ranks the account identity above its raw identifier', async () => {
    const source = await componentSource('P2PAccountPanel.vue')
    expect(source).toMatch(
      /\.p2p-account-identity-label\s*\{[^}]*font-size:\s*var\(--type-caption\)/u
    )
    expect(source).toMatch(/\.p2p-account-identity-id\s*\{[^}]*color:\s*var\(--color-text-muted\)/u)
    expect(source).toMatch(/\.p2p-account-identity-name\s*\{[^}]*font-size:\s*var\(--type-body\)/u)
  })

  it('ranks enrollment fact labels below their values', async () => {
    const source = await componentSource('P2PEnrollmentPanel.vue')
    expect(source).toContain('p2p-enrollment-facts')
    expect(source).toMatch(/\.p2p-enrollment-facts dt\s*\{[^}]*font-size:\s*var\(--type-caption\)/u)
    expect(source).toMatch(/\.p2p-enrollment-facts dd\s*\{[^}]*color:\s*var\(--color-text\)/u)
  })

  it('states every hierarchy size through the type scale', async () => {
    // A literal size would sit outside the token scale, which is how the
    // headings previously rendered at a size the scale does not contain.
    for (const name of ['P2PAccountPanel.vue', 'P2PEnrollmentPanel.vue']) {
      const styles = (await componentSource(name)).split('<style')[1] ?? ''
      expect(styles).not.toMatch(/font-size:\s*\d/u)
    }
  })
})
