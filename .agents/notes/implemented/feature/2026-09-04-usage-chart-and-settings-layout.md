# Token usage chart visibility and Settings layout consistency

## Context

Two renderer issues on the Token 消耗 (Token usage) and 设置 (Settings) routes: the
daily-token bar chart on the 统计 (Statistics) tab looked blank even with data
present, and the Settings route felt disconnected from the rest of the app.

## Evidence

### Chart

The chart markup and CSS were both present and correct, and the whole test
suite was green, yet the bars did not read as bars. Measured against the exact
values from the reported screenshot — 1.58M, 26.24M, 50.81M, 238.61M, 28.1K —
the cause was the scale, not zero-height rendering.

`chartHeight` was linear with a 4% floor: `Math.max(4, (value / maximum) * 100)`.
With a 238.61M peak, the 28.1K day is 0.01% of the maximum, so it clamped to the
4% floor and computed to a 5px bar inside a 128px plot (confirmed by CDP:
`barRectH: 5`). Four of five days collapsed into slivers on the baseline, which
read as an empty chart. A second flaw: `.usage-bar-chart` and `.usage-chart-plot`
each drew a `border-bottom`, so a second axis line sat below the date labels and
made the bars look detached from their baseline.

### Settings

CDP measurement: `.settings-panel` rendered at width 896 inside a 1140 stage
(`panelLeft: 222`, `stageLeft: 100`), from a `max-width: 56rem; margin-inline: auto`
rule no other route carries. 版本管理 and Token 消耗 fill the stage edge to edge,
so Settings sat in ~120px of dead margin on both sides. Section headers used
plain divider lines while their bodies used filled cards, and each appearance
row was itself a card — boxes inside boxes.

## Decision

Chart uses a square-root scale, `Math.sqrt(value / maximum)`, with a 6% floor
and a 3px bar `min-height`. Sqrt lifts small days into view while keeping
ordering honest; a log scale was rejected because it flattened a 151x
difference into near-equal bars (1.58M reached ~74% of the peak). The plot
height grew from 8rem to 11rem so small bars have room, and the duplicate
`border-bottom` on `.usage-bar-chart` was removed, leaving one baseline on
`.usage-chart-plot` directly under the bars. Exact values remain in the bar
label and the table below, so the scale never has to carry precise magnitude.

Settings fills the stage like every other route: the `max-width`/`margin-inline`
column was removed. Each `.settings-section` is now one card (the header and
body share a surface); appearance rows are separated by rules instead of each
being a nested card. The launcher tab uses a `.settings-tab-panel--split`
two-column grid above 68rem so the narrow appearance controls and the wider
managed-directory panel sit side by side instead of stacking with dead space.

## Consequences

Every non-zero day is now visible (measured 11–175px for the reported spread)
and the chart reads as a chart. Settings aligns with the stage and the rest of
the app. Two regression suites were added because both defects were invisible to
the existing tests: `usageChartScale.test.ts` pins the floor, ordering, sqrt
scale, and single baseline; `settingsLayout.test.ts` pins full-stage width, the
card-per-section treatment, rule-separated rows, and the split grid.

The two locale catalogs in `i18n.ts` were extracted into `messages.zh-CN.ts` and
`messages.en-US.ts` because the added error-code strings pushed `i18n.ts` past
the 1000-line budget; `i18n.ts` keeps only the locale list, types, and
`createTranslator`.
