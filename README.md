<p align="center">
  <img src="resources/dsh-launcher-logo-launcher.png" alt="DSHKer otter logo" width="128" />
</p>

# DSHKer Launcher

**Run DeepSeek Harness like an app.** Install it, press start, and get to work — on this computer or on any of your others, from one window.

[简体中文](README.zh-CN.md) · [Usage guide](docs/usage.en.md) · [Product screenshots](docs/screenshots.md) · [Latest release](https://github.com/ankye/dshker/releases/latest) · [GitHub Actions builds](https://github.com/ankye/dshker/actions/workflows/package.yml)

## What it does for you

- **Start in one click.** The Launcher prepares and runs the standard DSH Web session for you: nothing to install by hand, no command to remember, and no terminal window to keep open.
- **Move between versions safely.** See which cores are available, switch to a newer one when you want it, and go back when something misbehaves.
- **Put all your computers in one window.** Add the machines you already use and open each as a tab next to Local — no DSH credentials copied by hand, no ports opened to the internet.
- **Connect without exposing yourself.** Machines are authenticated one by one: you decide which computers may reach each other, and a remote session can only browse the folders you grant it.
- **See what is going on.** A console follows the real process output, and Token usage totals come from the logs DSH already writes.
- **Your data stays yours.** Harness, plugins, presets, settings and your native `~/.dsh` folders stay where they are: the Launcher reuses them and never silently replaces or resets them.
- **Old machines clean up after themselves.** Signing in on a new computer enrols it automatically, removing one takes its pairings with it, the network you picked is remembered, and a computer that is no longer part of the network you are looking at says so instead of quietly disappearing.

DSHKer Launcher is a desktop app for running [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) on macOS and Windows.

The Launcher never replaces, moves, or resets native DSH state. Your existing `$DSH_HOME` or `~/.dsh` remains owned by DeepSeek Harness and is reused when you change the selected core version.

![DSHKer otter workbench — the current launch-page background artwork](resources/dshker-hero-workbench.png)

The otter logo and workbench artwork above are the assets used by the current source version. For interface captures, see [product screenshots](docs/screenshots.md); published installers may lag behind `main`.

## Remote connections

Keep your DSH machines together without exposing DSH Web to the network. The current desktop connection path uses **SSH tunnels**, forwarding HTTP and WebSocket traffic to the remote DSH's actual loopback address and port.

- **Computer management:** the SSH page keeps a focused computer list and one **Add computer** entry point. The form opens in a labelled dialog with an explicit close action; add a display name, host, SSH port, user, and optional local SSH key path. Edit saved connections or remove computers you no longer need. Disconnect before changing the SSH destination or key path; changing either clears the previous test result, so test the new settings again.
- **Test before connecting:** verify SSH authentication, the remote DSHKer handshake and DSH access. A successful test is separate from an active connection.
- **Visible status:** green indicates readiness or a passed test; red indicates failure, with text describing the state. Paired computers connect and reconnect on their own; an explicit disconnect is available when you want one.
- **On-demand tabs:** one Local tab is always available; click **+** in Run, then choose a computer from the floating **LAN computers** or **SSH connections** list to create its non-closable tab. Ready workspaces are listed first; unavailable ones remain visible but disabled at the bottom. Disconnecting does not remove an opened computer tab.
- **No manual DSH token copying:** the authenticated connection obtains the DSH Web credential. SSH authentication is still required; the app never asks for SSH passwords or transfers private-key contents, and an explicit key path is passed directly to OpenSSH.
- **Stay signed in after upgrades:** the account session lives in the system credential store. On startup or after installing a new version, the UI shows restoration progress and refreshes automatically; sign-in is requested only after the server explicitly rejects the session.

To connect:

1. Run DSHKer on the remote computer and ensure it can start its managed DSH Web session.
2. Configure the remote SSH server and verify access using your system OpenSSH configuration, agent, or a local identity file path, including trusted host keys.
3. Open **Remote connections**, enter the computer details, choose **Test**, then **Connect**. In **Run**, click **+** and choose the computer from the SSH list.

The form's port is the **SSH port**, not the DSH Web port. DSHKer obtains the current DSH endpoint instead of assuming `3080`. If you see `remote.peer_unavailable`, check that remote DSHKer is running and can provide a DSH session; an accessible SSH server alone is not enough.

### Self-hosted P2P workbench

Connect two of your own computers directly through a coordination server you
host, without exposing DSH Web to the network and without an SSH tunnel. The
independent [DSHKer Server](https://github.com/ankye/dshker-server) provides
user-scoped networks and authenticated device pairing.

The desktop implementation and its automated tests are complete: automatic
pairing between devices in the same network, connection staging, per-computer
isolated browser sessions, remote authorized-directory browsing and project
selection, shared server configuration editing, and post-disconnect task
reconciliation.

In **Remote connections → Network & account**, the signed-in workspace keeps
only the account and network task. Select a network from one labelled picker;
the nearby **Create network** button opens a modal. The selected network shows
its ID, device limit, and computers, while rename, limit, and deletion are
grouped in **Manage network**. Account technical IDs, local enrollment/recovery,
and pairing panels are not repeated in the primary workspace.

The workspace uses one clear surface with spacing and row separators instead of
nested boxes, while all network IDs, presence states and actions remain visible.

Use **Settings → Launcher settings** to enable or disable the networking core's start-at-boot registration. The switch reads dshkerd's actual registration state; if the core is temporarily unavailable it says so explicitly instead of presenting a false “not installed” state.

After joining, **My network** keeps the joined network ID, device ID, copy
actions, and **Leave network** action visible together, so you can confirm the
local-network scope before removing this computer.

The Network & account page keeps the state explicit with labels such as “Joined ·
signed out” and “Service online”. The sign-in panel presents one next step instead
of repeating network, account, and server explanations; transient busy reads stay
neutral, while technical refusal codes are available under diagnostics.

If the coordinator is still starting or its catalog is being read, the local
device name, device ID, and sign-in/register entry remain visible. The auth
controls are disabled with an explicit readiness explanation until the service
is available.

The adjacent **SSH connections** tab uses the same compact layout. Saved computers and
connection tests come first; **Add computer** opens a dialog instead of expanding the page.
This tab is limited to SSH connection tasks; network joining and the complete
**My network** identity, enrollment status, leave action, and device details
live under **Network & account** so connection tasks and account management stay
separate.

Devices bound to the same network appear in that network's computer list and
can enter the connection flow directly; the account page does not duplicate a
separate pairing step. Explicit authorization remains available for a device
that is not in one of your networks.

The device list is that network's membership: each computer shows its liveness, last
seen time and reported build. **Remove** takes a device out of the network and drops
the pairs it had there — an unbind affects only that network, so the machine keeps its
own identity and can enrol again — while **revoke** ends a single pairing and leaves
the device in place. The network you selected is remembered for the account that chose
it, and a machine that is no longer a member says so instead of going missing.

**Two-machine acceptance has completed.** A real session between two
machines — a Mac driving the DSH Web runtime on a Windows host through the
P2P stack, over the live coordination server — has been verified end to end:
the connection reported its selected path, opened the local gateway URL, and
loaded the remote DSH Web page through the tunnel. Repeated reconnects have been
stress-tested in both directions (each machine as the initiator and as the
runtime host) with the address proven stable across every cycle.

Paired computers are connected **without being asked**. Connecting happens at
startup for every active pair, a dropped connection is retried on its own —
immediately at first, then with a widening delay — and waking the machine or
regaining a network retries at once. Only losing authorization (revoking the
pair, or deleting its network) stops the attempts. Switching between tabs never
interrupts a connection: it belongs to the pair, not to the view.

A remote workspace keeps the **same address** across all of that. The gateway
that serves a paired computer's DSH Web belongs to the pair rather than to one
connection, so a browser tab left open on it survives a drop, a network change,
a wake from sleep and even a restart of the other computer's DSH, and recovers by
itself. While no session is attached the address still answers but proxies
nothing, so nothing stale is reachable.

Two limits worth knowing before you plan around it: when no direct UDP path
can be established, the connection falls back to your own deployment server as
an opaque relay (TURN) and only fails with `direct_unavailable` when neither
path can be established — the relay never sees plaintext; and authorized
directories only constrain the folder picker in this app — once a project is
open, DSH's own permission and approval policy on the other computer still
governs everything.

The same core also runs **with no desktop session at all**, which is what makes
a machine you only reach over SSH a usable host. `dshkerd serve` publishes its
own private endpoint and answers the whole method table; `dshkerd dsh start`
and `dshkerd dsh stop` run the DSH Web child under a fixed subject of their own;
`status`, `pair`, `connect`, `proxy` and `service configure` are named
commands over the operations the app performs, and `call` reaches any published
method with its refusal code printed verbatim for scripting. The app is
unaffected — when no registered headless core is present it starts the core as
its own child and keeps its own launch subject.

When networking autostart is enabled, Launcher attaches to the already-running
headless core through its authenticated local endpoint instead of starting a
second device identity. Quitting or disabling autostart uses an explicit
handoff, while an enabled headless core remains available for SSH-only use.

See the [user guide](docs/p2p-connections.md) and the
[implementation checklist](openspec/changes/add-self-hosted-p2p-dsh-connections/tasks.md).

## How it works

- **One background core, also headless.** A single core process owns the private
  channel, the root registry, credentials and the whole peer protocol, so the app runs
  one background process rather than two. The same binary also hosts with no desktop
  session at all: `dshkerd serve`, `dsh start|stop`, `status`, `pair`, `connect`,
  `proxy`, `service configure` and `call`.
- **Self-hosted remote workbench.** Connect your own computers through a
  [coordinator you host](https://github.com/ankye/dshker-server): devices in the same
  network pair themselves, each computer gets an isolated browser session, and remote
  directories and projects are browsed over the authorized path.
- **SSH path.** The other remote path is an **SSH tunnel**, forwarding HTTP and
  WebSocket traffic to the remote DSH's real loopback address and port.

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

### Install only the headless `dshkerd` CLI

Servers and remote peers that do not need a desktop can install the standalone Go core without Electron. Choose an exact published version; the installer downloads the matching OS/architecture archive from the official Release, verifies SHA256 and the embedded manifest, and atomically replaces only the CLI binary. It does **not** configure a coordinator, copy credentials, pair a device, or enable autostart.

macOS and Linux (one-command install):

Replace `0.1.65` below with an exact published version that includes the CLI assets.

```bash
VERSION=0.1.65
curl -fsSL "https://raw.githubusercontent.com/ankye/dshker/v${VERSION}/tools/install-dshkerd.sh" \
  | bash -s -- --version "$VERSION"
```

The default install path is `~/.local/bin/dshkerd`; use `--install-dir /absolute/path` to choose another user-writable directory. For an auditable install, download the script from the same `v${VERSION}` tag first and run it locally. The script requires `curl`, `tar`, and `shasum` or `sha256sum`.

Windows PowerShell:

```powershell
$Version = '0.1.65'
$Script = Join-Path $env:TEMP 'install-dshkerd.ps1'
Invoke-WebRequest "https://raw.githubusercontent.com/ankye/dshker/v$Version/tools/install-dshkerd.ps1" -OutFile $Script
& powershell -ExecutionPolicy Bypass -File $Script -Version $Version
```

The default Windows install path is `%LOCALAPPDATA%\DSHKer\bin\dshkerd.exe`. Add that directory to `PATH` explicitly if you want to call `dshkerd` from any shell. After installation, configure the values for your deployment explicitly, then start and inspect the headless host:

```bash
dshkerd --version
dshkerd service configure --origin https://your-coordinator.example --wss wss://your-coordinator.example/ws --stun stun:your-coordinator.example:3478 --pinned-key /absolute/path/coordinator-ca.pem
dshkerd serve --state ~/.dshkerd
dshkerd status --state ~/.dshkerd --json
dshkerd autostart enable --state ~/.dshkerd
```

Upgrade by running the same installer with the new explicit version. To uninstall the binary, stop any running `dshkerd` process and remove only the installed file (`rm -f ~/.local/bin/dshkerd` on POSIX or `Remove-Item "$env:LOCALAPPDATA\DSHKer\bin\dshkerd.exe"` in PowerShell); the installer never removes the separate `~/.dshkerd` state directory. The service, trust, pairing, connection, and DSH Web commands are intentionally separate. Follow `dshkerd --help` and the [headless core guide](docs/p2p-connections.md) for `pair`, `connect`, `dsh start|stop`, and `proxy`; a missing required value is reported as a typed refusal rather than guessed.

## Check for Launcher updates

Open **Settings → Launcher settings → Updates** to check the fixed DSHKer GitHub Release feed. The Launcher also performs this check in the background after startup without blocking the window. It shows a startup notice only when GitHub reports a higher stable semantic version; a network or feed failure remains available in Settings for an explicit retry instead of interrupting startup.

When an update is available, **Download** shows progress in the Launcher and saves the exact installer asset for the current macOS or Windows architecture to the system Downloads folder. Missing, duplicate, or unsupported platform assets are reported as errors; the Launcher does not choose another package. Installation remains a user-controlled manual step because the current macOS and Windows packages are unsigned. Release notes are shown in the Launcher language.

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
7. **Browser** — use Local and open remote computer tabs on demand for DSH Web sessions.

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

`package.json` is the only Launcher version source. The `npm run dist:*` scripts create local unsigned installers for macOS arm64/x64 and Windows x64/arm64. `npm run build:dshkerd` creates the six standalone CLI archives and manifests, or use a target-specific `npm run build:dshkerd:*` script. A stable `v*` tag must equal `v${package.json.version}` exactly. After all desktop and CLI builds pass, GitHub Actions verifies their manifests and checksums, then creates the public latest GitHub Release with both product channels. A manual workflow dispatch uploads Actions artifacts but never publishes a Release.

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
