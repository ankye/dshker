# Catalog install table narrow-screen readability

## Context

On the 安装新扩展 (installable-extension catalog) tab, narrowing the window let the
description column collapse into a tall, one-character-per-line tower. The row
"拉升" the user reported was that column stretching vertically while the plugin
id and repository columns held their full width. The catalog table uses the
browser default `table-layout: auto`; the description cell allowed
`overflow-wrap: anywhere`, so its minimum-content width is effectively a single
character. When the rendered panel width landed below the sum of the other
columns' preferred widths, auto layout shrank the description to that
minimum instead of overflowing into the table's horizontal scroll area.

## Decision

Give the description a real minimum width so it can never be crushed, and give
the other content columns explicit minimums so auto layout has a predictable
floor. The table keeps its single-line-ellipsis behavior for name/category/
repository and still wraps descriptions in place — the catalog must not infer a
plugin's purpose from a clipped summary, so no line-clamp is introduced.

- `.catalog-table` minimum width 860px → 880px so the column floors fit.
- `.catalog-name-cell`, `.catalog-category-cell`, `.catalog-url-cell` gain
  minimums (8 / 4.5 / 12rem) alongside their existing maximums.
- `.catalog-desc-cell` gains `min-width: 16rem`.
- Below 980px the persistent category rail narrows from
  `minmax(9rem, 12rem)` to `minmax(7rem, 9rem)` so the results panel keeps more
  of the viewport.

Below the table's minimum width the panel scrolls horizontally (`.version-table-wrap`
already has `overflow: auto`), which is the existing desktop pattern rather than
a cramped squeeze.

## Consequences

The description column stays readable at any window width. Narrow windows show a
legibly sized, scrollable table instead of a vertically stretched column; wide
windows are unchanged because every floor is below the existing maximum. No
column is clipped, so the "don't infer from a clipped summary" rule holds.
