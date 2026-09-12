<p align="center">
  <img src="resources/dsh-launcher-logo-launcher.png" alt="DSHKer otter logo" width="128" />
</p>

# DSHKer Launcher

One desktop home for your local and remote DeepSeek Harness sessions.

[简体中文](README.zh-CN.md) · [Usage guide](docs/usage.en.md) · [Product screenshots](docs/screenshots.md) · [Latest release](https://github.com/ankye/dshker/releases/latest) · [GitHub Actions builds](https://github.com/ankye/dshker/actions/workflows/package.yml)

## Core features

- **Multiple computers, one workspace** — manage trusted SSH connections, test the full DSH session path, and open per-computer Run tabs on demand alongside Local without manually copying DSH Web credentials.
- **One-click DSH Web** — prepare the bundled Harness seed, select a core commit, and start the standard DSH Web command.
- **Version control** — refresh remote history, inspect commits, and explicitly switch the managed DSH core.
- **Extension management** — see installed extensions and browse the curated Awesome DSH Plugin catalog.
- **Console and on-demand runtime tabs** — follow exact process output, stop the managed process, and keep Local available while creating a remote tab only when you choose a ready workspace from Run’s **+** picker.
- **Token usage** — read session and daily model totals from native DSH logs without writing native DSH data.
- **Safe ownership boundaries** — keep Harness, plugins, presets, settings, and native `~/.dsh` data in their declared roots without silently replacing them.

DSHKer Launcher is a desktop shell for running [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) on macOS and Windows.

The Launcher never replaces, moves, or resets native DSH state. Your existing `$DSH_HOME` or `~/.dsh` remains owned by DeepSeek Harness and is reused when you change the selected core version.

![DSHKer otter workbench — the current launch-page background artwork](resources/dshker-hero-workbench.png)

The otter logo and workbench artwork above are the assets used by the current source version. For interface captures, see [product screenshots](docs/screenshots.md); published installers may lag behind `main`.

## Remote connections

Keep your DSH machines together without exposing DSH Web to the network. The current desktop connection path uses **SSH tunnels**, forwarding HTTP and WebSocket traffic to the remote DSH's actual loopback address and port.

- **Computer management:** add a display name, host, SSH port and user; edit saved connections or remove computers you no longer need. Disconnect before changing connection details.
- **Test before connecting:** verify SSH authentication, the remote DSHKer handshake and DSH access. A successful test is separate from an active connection.
- **Visible status:** green indicates readiness or a passed test; red indicates failure, with text describing the state. Connect and disconnect explicitly.
- **On-demand tabs:** one Local tab is always available; click **+** in Run, then choose a computer from the floating **LAN computers** or **SSH connections** list to create its non-closable tab. Ready workspaces are listed first; unavailable ones remain visible but disabled at the bottom. Disconnecting does not remove an opened computer tab.
- **No manual DSH token copying:** the authenticated connection obtains the DSH Web credential. SSH authentication is still required; the app neither asks for SSH passwords nor transfers private keys.

To connect:

1. Run DSHKer on the remote computer and ensure it can start its managed DSH Web session.
2. Configure the remote SSH server and verify access using your system OpenSSH configuration or agent, including trusted host keys.
3. Open **Remote connections**, enter the computer details, choose **Test**, then **Connect**. In **Run**, click **+** and choose the computer from the SSH list.

The form's port is the **SSH port**, not the DSH Web port. DSHKer obtains the current DSH endpoint instead of assuming `3080`. If you see `remote.peer_unavailable`, check that remote DSHKer is running and can provide a DSH session; an accessible SSH server alone is not enough.

### In development: self-hosted P2P workbench

Connect two of your own computers directly through a coordination server you
host, without exposing DSH Web to the network and without an SSH tunnel. The
independent [DSHKer Server](https://github.com/ankye/dshker-server) provides
user-scoped networks and authenticated device pairing.

The desktop implementation and its automated tests are complete: automatic
pairing between devices in the same network, connection staging, per-computer
isolated browser sessions, remote authorized-directory browsing and project
selection, shared server configuration editing, and post-disconnect task
reconciliation.

In **Remote connections → Network & account**, networks appear as compact rows.
Select a network by name to view its computers; expand **Manage network** to
rename it or change its device limit. Internal IDs are available in technical
details for troubleshooting rather than displayed throughout the main view.

The adjacent **Connect** tab uses the same compact layout. Saved computers and
connection tests come first; adding and managing a computer expands on demand.
**My network** keeps the computer name and status visible, with device IDs and
membership settings in separate expandable sections.

Devices bound to the same network pair themselves with no invite code and no
approval step: joining the network is the authorization. The invite-and-confirm
flow remains for pairing a device that is not in one of your networks.

**Two-machine acceptance has completed.** A real session between two
machines — a Mac driving the DSH Web runtime on a Windows host through the
P2P stack, over the live coordination server — has been verified end to end:
the connection reported its selected path, opened the local gateway URL, and
loaded the remote DSH Web page through the tunnel.

Two limits worth knowing before you plan around it: when no direct UDP path
can be established, the connection falls back to your own deployment server as
an opaque relay (TURN) and only fails with `direct_unavailable` when neither
path can be established — the relay never sees plaintext; and authorized
directories only constrain the folder picker in this app — once a project is
open, DSH's own permission and approval policy on the other computer still
governs everything.

See the [user guide](docs/p2p-connections.md) and the
[implementation checklist](openspec/changes/add-self-hosted-p2p-dsh-connections/tasks.md).

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
6. **Remote connections** — register, test, connect, and monitor trusted DSHKer computers through loopback SSH tunnels.
7. **Run** — use Local and open remote computer tabs on demand for DSH Web sessions.

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
