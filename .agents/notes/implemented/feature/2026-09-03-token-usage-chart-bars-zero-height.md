# Token usage chart bars render at zero height

The Statistics tab's column chart rendered its value and date labels but no
bars: the plot area was an empty band. The bars are empty spans sized by an
inline percentage `height` (daily total uses `chartHeight(day.total,
dailyTotalMax)`, by-model uses `chartHeight(bar.total, dailyModelMax)`). That
percentage only resolves against a definite containing-block height, but
`.usage-chart-plot` set only a `min-height` (`8rem`), so its height was
content/auto. With no definite height the percentage is treated as `auto`,
and the empty span collapses to 0 tall — invisible bars. Verified by rendering
the component's exact markup/CSS in an offscreen Chromium and observing the
same empty band, then confirming bars appear after the fix.

```css
.usage-chart-plot {
  height: 8rem; /* was min-height: 8rem */
}
```

The by-model (grouped) view had a second defect: its `.usage-chart-day` holds
only a plot and a label (no value span), so CSS grid auto-placement put the
plot in the top `auto` row and the label in the middle `minmax(8rem,1fr)`
row, pushing the bars off the baseline and leaving a tall empty band. Fixed by
giving the model day its own track template via a modifier class.

```css
.usage-chart-day--model {
  grid-template-rows: minmax(8rem, 1fr) auto;
}
```

No data, IPC, or computed-value changes; the fix is purely layout so the
chart matches what the table already reported.
