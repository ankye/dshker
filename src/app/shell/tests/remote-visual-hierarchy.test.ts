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
  const componentPath = path.join(appRoot, 'src/app/shell/components', name)
  const source = await readFile(componentPath, 'utf8')
  const linkedStyle = source.match(/<style[^>]*\bsrc=["']([^"']+)["']/u)?.[1]
  if (!linkedStyle) return source
  return `${source}\n${await readFile(path.resolve(path.dirname(componentPath), linkedStyle), 'utf8')}`
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

  it('keeps the signed-in identity compact without exposing account technical data', async () => {
    const source = await componentSource('P2PAccountPanel.vue')
    expect(source).toMatch(
      /\.p2p-account-identity-label\s*\{[^}]*font-size:\s*var\(--type-caption\)/u
    )
    expect(source).toMatch(/\.p2p-account-identity-name\s*\{[^}]*font-size:\s*var\(--type-body\)/u)
    expect(source).not.toContain('p2p.account.accountDetails')
    expect(source).not.toMatch(/class="p2p-account-identity-id"/u)
  })

  it('ranks enrollment fact labels below their values', async () => {
    const source = await componentSource('P2PEnrollmentPanel.vue')
    expect(source).toContain('p2p-enrollment-facts')
    expect(source).toMatch(/\.p2p-enrollment-facts dt\s*\{[^}]*font-size:\s*var\(--type-caption\)/u)
    expect(source).toMatch(/\.p2p-enrollment-facts dd\s*\{[^}]*color:\s*var\(--color-text\)/u)
  })

  it('uses one network picker and a focused network summary instead of stacked cards', async () => {
    const source = await componentSource('P2PAccountPanel.vue')
    expect(source).toContain('test-id="p2p-network-select"')
    expect(source).toContain('data-testid="p2p-selected-network-summary"')
    expect(source).toContain('data-testid="p2p-network-create-dialog"')
    expect(source).toContain('data-testid="p2p-network-manage-dialog"')
    expect(source).not.toMatch(/class="p2p-network-card"/u)
    expect(source).not.toMatch(/class="p2p-network-toggle"/u)
    expect(source).not.toContain('p2p-network-columns')
    expect(source).not.toMatch(/p2p-network-columns[^\n]*aria-hidden/u)
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
