# Token usage daily model statistics

The Token usage page now exposes an Overview and a Statistics tab. Statistics groups token buckets by the DSH event timestamp's local calendar day and the active request-header model, then filters those cached rows in the renderer with direct date inputs and recent-range presets. The selected range also feeds two switchable column-chart views: daily total for trend scanning and grouped daily bars for model comparison. The exact table remains below them for values a chart should not replace.

`SessionUsageReader` keeps these daily/model aggregates beside its existing per-session fold in the Launcher-owned cache. A repeated read does not decompress unchanged session logs; an append resumes at the last consumed zstd frame and carries the most recent model header plus replacement slot, so a finalized usage report can replace its earlier streaming report in the correct daily bucket. Records without a timestamp continue to count in their session and all-time totals but are intentionally absent from daily statistics rather than being assigned a guessed date.

The usage refresh command now uses the shared icon-and-label action affordance. Its disabled, spinning state means the log reader is actually pending; changing only the visual date range is immediate and leaves that command idle.
