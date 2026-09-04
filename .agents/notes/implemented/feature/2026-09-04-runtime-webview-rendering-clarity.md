# Run WebView rendering clarity

## Context

DSH Web text in the Launcher's Run tabs appeared less sharp and darker than the same loopback page in Chrome on macOS and Windows. Display device-pixel ratios vary across monitors, so a correction that forces one device scale or couples page zoom to the active monitor would trade one mismatch for another. The Run canvas also framed the guest inside a margin, border, rounded clip, and darker surrounding surface, which reduced usable area and made the page look visually heavier.

## Evidence

Chrome's persisted zoom setting for the `127.0.0.1` host is zoom level `1.2239010857415449`, which Chromium maps to a page zoom factor of `1.25`. The current DSHKer Launcher profile has no corresponding loopback-host zoom record, so its guest uses factor `1.0`. The comparison was therefore Chrome at 125 percent against Launcher at 100 percent, not two renderers at the same page zoom. The current Launcher uses Electron 42.4.0 with Chromium 148.0.7778.254, while the inspected Chrome build uses Chromium 152.0.7977.76; that engine difference remains a secondary variable after zoom is aligned.

Electron's `<webview>` and `WebContentsView` both render through Chromium `WebContents`. A component migration by itself does not prove better text rasterization. The existing Run guest has no production device-scale override, CSS filter, or explicit page-zoom control, and its containing canvas adds decorative spacing and clipping around the remote page.

## Decision

Run page zoom is an explicit Launcher preference with fixed steps at 80, 90, 100, 110, 125, 150, 175, and 200 percent. The default is 100 percent only when the preference file does not exist. The strictly versioned record lives at `dsh-launcher/runtime-browser-preferences.json` below the currently registered Settings root; malformed or unsupported records block through a typed error without reset, clamping, or another storage location.

The toolbar owns decrease, current-value, and increase controls. `Cmd`/`Ctrl` plus `+`, `-`, or `0` applies inside Launcher chrome and the attached guest; Electron main handles the guest's bounded `before-input-event` path and synchronizes the effective value back to the toolbar. Page zoom remains independent of DPR. The Launcher does not force a device scale factor and does not change zoom when the window crosses displays.

The guest becomes a full-bleed canvas below one toolbar divider. Its element and container chain apply no CSS `filter`, `opacity`, `transform`, or `zoom`, and add no page-card margin, border, or rounded clipping. A copyable rendering observation reports host and guest DPR, guest zoom, `visualViewport.scale`, Electron and Chromium versions, display color space, and GPU compositing status. It does not read or expose the URL, query, cookies, storage, request headers, credentials, or tokens.

## Consequences

Chrome and Launcher can now be compared at the same explicit page zoom instead of attributing a 125-versus-100-percent difference to DPR. Moving between displays causes re-observation and Chromium re-rasterization but does not rewrite user zoom. Invalid Launcher preference state remains visible and recoverable rather than being hidden by a fallback.

`WebContentsView` is not adopted in this change. A migration is reconsidered only if a controlled same-URL, same-size, same-zoom comparison shows that the attached `<webview>` remains uniquely degraded after the explicit zoom and full-bleed changes. If every Electron surface remains equivalent and Chrome still differs, the next investigation is Electron/Chromium version, GPU compositing, and color-profile behavior rather than another UI-layer rewrite.
