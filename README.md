# DSHKer Launcher

[简体中文](README.zh-CN.md) · [Usage guide](docs/usage.en.md) · [Product screenshots](docs/screenshots.md) · [Latest release](https://github.com/ankye/dshker/releases/latest) · [GitHub Actions builds](https://github.com/ankye/dshker/actions/workflows/package.yml)

## Core features

- **One-click DSH Web** — prepare the bundled Harness seed, select a core commit, and start the standard DSH Web command.
- **Version control** — refresh remote history, inspect commits, and explicitly switch the managed DSH core.
- **Extension management** — see installed extensions and browse the curated Awesome DSH Plugin catalog.
- **Console and runtime tabs** — follow exact process output, stop the managed process, and open the URL it actually announces.
- **Token usage** — read session and daily model totals from native DSH logs without writing native DSH data.
- **Safe ownership boundaries** — keep Harness, plugins, presets, settings, and native `~/.dsh` data in their declared roots without silently replacing them.

DSHKer Launcher is a desktop shell for running [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) on macOS and Windows.

The Launcher never replaces, moves, or resets native DSH state. Your existing `$DSH_HOME` or `~/.dsh` remains owned by DeepSeek Harness and is reused when you change the selected core version.

![DSHKer Launcher launch screen](docs/assets/screenshots/launch.png)

![Version management](docs/assets/screenshots/versions.png)

## Install

1. Open the [latest GitHub Release](https://github.com/ankye/dshker/releases/latest).
2. Download the installer for your platform:
   - **macOS Apple Silicon**: the `mac-arm64.dmg` asset
   - **macOS Intel**: the `mac-x64.dmg` asset
   - **Windows x64**: the `win-x64.exe` asset
   - **Windows ARM64**: the `win-arm64.exe` asset
3. Verify the installer against the release's `checksums.txt`, install it manually, and start **DSHKer Launcher**.

Current release installers are unsigned. macOS may require **Open** from Finder's context menu, and Windows may show SmartScreen. Install only an asset obtained from this repository and verified against its checksum. The application does not silently replace itself.

If the repository has no published Release yet, the latest-release link has no update feed to return. [GitHub Actions package runs](https://github.com/ankye/dshker/actions/workflows/package.yml) remain short-lived build and diagnostic evidence; they are not the Launcher update feed.

## Check for Launcher updates

Open **Settings → Launcher settings → Updates** to check the fixed DSHKer GitHub Release feed. The Launcher also performs this check in the background after startup without blocking the window. It shows a startup notice only when GitHub reports a higher stable semantic version; a network or feed failure remains available in Settings for an explicit retry instead of interrupting startup.

When an update is available, **Download** opens the exact installer asset for the current macOS or Windows architecture in the system browser. Missing, duplicate, or unsupported platform assets are reported as errors; the Launcher does not choose another package. Installation remains a user-controlled manual step because the current macOS and Windows packages are unsigned.

## First launch

The first packaged launch creates these Launcher-owned directories automatically:

| Directory                 | Purpose                                             |
| ------------------------- | --------------------------------------------------- |
| `~/.dshlauncher/harness`  | Selected DeepSeek Harness checkout and build output |
| `~/.dshlauncher/plugins`  | Curated plugin catalog source                       |
| `~/.dshlauncher/presets`  | Launcher-downloaded preset sources                  |
| `~/.dshlauncher/settings` | Launcher preferences and records                    |

If the Harness directory is empty, the application unpacks the bundled DSH source there in the background, installs its locked dependencies, and builds it. The Launch button stays disabled until that work completes; the app window remains usable.

Then use the sidebar in this order when needed:

1. **Launch** — review the selected commit and start DSH Web.
2. **Console** — follow the exact process output and stop the managed process.
3. **Version management** — refresh, switch, and inspect core and extensions.
4. **Token usage** — inspect session and daily model totals from native DSH logs.
5. **Settings** — manage DSH and Launcher settings, including update checks.
6. **Run** — open the URL announced by the process in separate tabs.

For step-by-step details, troubleshooting, and the directory ownership model, read the [English usage guide](docs/usage.en.md) or [Chinese usage guide](docs/usage.zh-CN.md).

## Development

Requirements: Node.js `^20.19.0 || >=22.12.0` and npm `>=10`.

```bash
npm ci
npm run dev
```

Run the focused checks:

```bash
npm run environment:check
npm run format:check
npm run architecture:check
npm run type-check
npm test -- --run
npm run service:smoke
npm run visual:smoke
npm run build:electron
```

## Build and release

`package.json` is the only Launcher version source. The `npm run dist:*` scripts create local unsigned installers for macOS arm64/x64 and Windows x64/arm64. A stable `v*` tag must equal `v${package.json.version}` exactly. After all four builds pass, GitHub Actions verifies their manifests and checksums, then creates the public latest GitHub Release with all four installers, a combined `checksums.txt`, and platform-named manifests. A manual workflow dispatch uploads Actions artifacts but never publishes a Release.

See [docs/release.md](docs/release.md) for the release handoff and [docs/ci.md](docs/ci.md) for CI gates.

## Repository layout

- `electron/` — Electron main process, preload bridge, security, and process supervision.
- `src/app/` — Vue user interface and product domains.
- `src/shared/` — typed renderer/main contracts.
- `resources/` — application visuals and bundled Harness seed metadata.
- `docs/` — usage, architecture, development, CI, and release documentation.

## Open source

- [DSHKer Launcher](https://github.com/ankye/dshker)
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
