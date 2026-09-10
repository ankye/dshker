# macOS app icon: replace auto-converted ICNS with a verified standard ICNS — 2026-09-10

## Symptom

The packaged app icon showed color noise at 16x16 and 32x32 in Finder, while
128x128 and up looked correct. The DMG and the installed app carried byte-identical
icon.icns files, ruling out copy corruption.

## Root cause

electron-builder 26.15.2 auto-converts the PNG passed as build.icon into
icon.icns during packaging. The generated small-size layers decode to garbage:
decoded 16x16 and 32x32 layers had pixel MAE ~115 and ~104 (scale 0-255) versus
the expected downscale of the source art — i.e. the layers are not the icon at
all. 128x128 was fine (MAE 6.2, plain resampling). The conversion bug is in the
packaging toolchain, not the source PNG and not Finder cache.

## Fix

Build a standard multi-layer icns ourselves and stop letting electron-builder
convert:

- Source: resources/dsh-launcher-logo-launcher.png (1254x1254; verified identical
  to resources/icon-512.png at 512x512, MAE 1.6).
- Downscale to a 1024x1024 master, then produce the full 10-layer iconset
  (16/32/64/128/256/512/1024, 1x and @2x) with sips.
- Compile with macOS iconutil into resources/icon.icns (standard ICNS).
- package.json build.mac.icon now points at resources/icon.icns, so the mac
  package uses the verified file directly. Windows/Linux keep the global
  PNG-driven icon path and are unaffected.

## Verification

Compiled icns decodes back to all 10 layers; every layer matches its expected
sips downscale pixel-for-pixel (MAE 0.000 for 32px and up; 1.456 / 0.958 for
the 16x16 resampled edges — normal anti-aliasing, versus ~115 before).
Rebuilt dshker-launcher-0.1.26-mac-arm64.dmg and mac-x64.dmg; the app bundle
inside carries the 2.1 MB standard icns and decodes layer-perfect.
