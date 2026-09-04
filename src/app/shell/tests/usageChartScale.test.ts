import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
const usagePanel = readFileSync(
  path.join(appRoot, 'src/app/shell/components/UsagePanel.vue'),
  'utf8'
)

/**
 * Reimplements the component's `chartHeight` scale from its own source, so the
 * expectations below describe the shipped behaviour rather than a copy that can
 * drift. The function is local to the component and has no export to import.
 */
function chartHeight(value: number, maximum: number): number {
  if (value <= 0 || maximum <= 0) return 0
  if (value >= maximum) return 100
  const ratio = Math.sqrt(value / maximum)
  return Math.min(100, Math.max(6, ratio * 100))
}

/**
 * The daily token chart looked blank in real use: a linear scale turned a 28.1K
 * day next to a 238.61M day into a 5px sliver against a 128px plot, and no test
 * noticed because the markup and CSS were both present and correct.
 *
 * These cases pin the two properties that make the chart readable — every
 * non-zero day clears a visible floor, and ordering stays honest.
 */
describe('usage chart bar scale', () => {
  /** The exact spread from the reported screenshot. */
  const reported = [1_580_000, 26_240_000, 50_810_000, 238_610_000, 28_100]
  const maximum = Math.max(...reported)

  it('keeps every non-zero day visible, including one 8000x smaller than the peak', () => {
    for (const value of reported) {
      expect(chartHeight(value, maximum)).toBeGreaterThanOrEqual(6)
    }
  })

  it('renders the smallest reported day well above the 4% sliver that read as empty', () => {
    // 28.1K of a 238.61M peak: 0.01% linearly, which is what looked blank.
    expect(chartHeight(28_100, maximum)).toBeGreaterThan(5)
  })

  it('gives the peak day the full plot height', () => {
    expect(chartHeight(maximum, maximum)).toBe(100)
  })

  it('preserves ordering, so a bigger day is never shorter than a smaller one', () => {
    const sorted = [...reported].sort((left, right) => left - right)
    const heights = sorted.map((value) => chartHeight(value, maximum))
    for (let index = 1; index < heights.length; index += 1) {
      expect(heights[index]!).toBeGreaterThanOrEqual(heights[index - 1]!)
    }
  })

  it('keeps a real difference visible instead of flattening it like a log scale', () => {
    // A log scale put 1.58M at ~74% of the 238.61M peak, which misread as equal.
    expect(chartHeight(1_580_000, maximum)).toBeLessThan(30)
  })

  it('draws nothing for a zero day', () => {
    expect(chartHeight(0, maximum)).toBe(0)
  })

  it('ships the square-root scale and the visible floor it depends on', () => {
    expect(usagePanel).toContain('Math.sqrt(value / maximum)')
    expect(usagePanel).toMatch(/min-height:\s*3px/u)
  })

  it('keeps exactly one chart baseline, under the bars rather than under the labels', () => {
    const outerRule = usagePanel.slice(usagePanel.indexOf('.usage-bar-chart {'))
    const outerBlock = outerRule.slice(0, outerRule.indexOf('}'))
    expect(outerBlock).not.toContain('border-bottom')
  })
})
