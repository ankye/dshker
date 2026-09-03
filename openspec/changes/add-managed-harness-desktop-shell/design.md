## Context

See [proposal.md](proposal.md) for the motivation. DSHKer Launcher (repository `dsh-launcher`) is an independent Electron, Vite, Vue, and TypeScript product. It manages DeepSeek Harness source revisions but does not embed Harness source or load Harness packages inside Electron's main or renderer processes.

DeepSeek Harness already resolves its native home from an inherited non-empty `DSH_HOME` or, otherwise, `~/.dsh`. That location contains Harness-owned durable state and must remain stable when the launcher selects a different Git revision. The launcher therefore cannot make a per-worktree `.dsh`, derive a replacement home, or migrate native Harness state.

This change requires no DeepSeek Harness modification. Harness ships no `desktop` application profile, descriptor parser, or child IPC counterpart, so the launcher starts the ordinary built `dsh web --no-open` command and connects to the loopback URL that process announces. The launcher does not share runtime classes with Harness or substitute a different application entry point.

## Goals / Non-Goals

**Goals:**

- Start with product-owned default storage; require no directory choices before cloning or opening a Harness workspace.
- Clone a user-selected Harness remote, resolve a selected branch, tag, or commit to an immutable SHA, and run only the resulting detached worktree.
- Reuse the native Harness home across branch and version changes without the launcher reading or changing it.
- Keep managed source and Launcher settings separate while using DSH's own profile, plugin, and Agent directories.
- Require explicit Git, Node.js, and pnpm identities, and treat only the child's own announced startup URL as readiness.
- Keep operating-system authority in Electron main and expose a narrow, typed renderer API.

**Non-Goals:**

- Reimplement Harness Session, settings, credentials, workspace, terminal, approval, question, or plugin semantics in the launcher.
- Change, migrate, clear, copy, create, or select a native Harness home.
- Mutate an unmanaged checkout; the launcher only creates and mutates its own mirror and worktrees.
- Search `PATH`, use a global `dsh`, substitute a tool, select a different ref, or use loopback Web or SDK transport as a fallback.
- Automatically delete retained worktrees or plugin/configuration generations.

## Decisions

### Decision: Defaults remove first-run directory setup

The Launcher creates its private roots under the platform application-data directory on first use. It does not show a four-directory setup flow. Harness mirrors and worktrees live under the default Harness root; internal launch records live under default Launcher Settings. Settings storage is the one explicitly relocatable Launcher location.

| Root | Launcher-owned contents | Excluded contents |
| --- | --- | --- |
| Harness | managed mirrors, exact-SHA worktrees, build artifacts, operation records | configuration, plugins, Launcher settings, native Harness home |
| Plugins | none; DSH owns `$DSH_HOME/profiles/web` and `dsh plugin --profile web` | Harness source, Launcher settings |
| Configuration | non-secret launch policy | source, Launcher settings, native Harness home |
| Settings | Launcher registry, installation catalog, preferences, diagnostic references | source, plugins, configuration, native Harness home |

The platform bootstrap locator contains only the Launcher Settings location. Relocation rejects a filesystem root, a user home, a symbolic-link or junction escape, a root overlap, a `.dsh` path segment, and any path equal to, above, or below the resolved native Harness home.

Alternative considered: derive an additional runtime root and put `.dsh` beneath it. Rejected because version changes would create divergent Harness identities and contradict normal `DSH_HOME` resolution.

### Decision: Display name changes without changing persistent identities

The product is displayed as DSHKer Launcher in the application window, installer, documentation, release artifacts, and fixed source link. The existing `dsh-launcher` app id, bundle id, IPC channel namespace, local preference keys, resource names, and `~/.dshlauncher` directory remain stable. Renaming any of those persistent identifiers would split existing user state or require an explicit migration, which is outside this display-name change.

### Decision: Native Harness home remains external and unchanged

At child spawn, the launcher passes no private descriptor input. It does not set, clear, override, translate, inspect, or migrate `DSH_HOME`. The child inherits normal Harness resolution: a valid inherited `DSH_HOME`, otherwise `~/.dsh`.

Changing a branch, tag, or commit changes the selected managed worktree only. If that revision cannot safely use the existing native state, preflight or the child reports the incompatibility and the launcher blocks readiness. It does not create a fresh home, switch to another revision, or repair state automatically.

Alternative considered: use one home per worktree. Rejected because it would force users to configure each branch again and would make branch switching silently alter durable Harness identity.

### Decision: Managed Git uses one mirror and immutable worktrees

For a selected remote, the launcher creates its own managed mirror under the Harness root. A user-selected branch, tag, or commit is resolved from that mirror to one exact SHA. The launcher materializes a detached worktree for that SHA and records the observed ref separately as display and update metadata.

Ref updates never rewrite an active worktree. A rewritten branch or tag remains a visible observation; moving to its new SHA requires explicit selection. Unmanaged repositories can be inspected only through a separately granted read-only capability and are never checked out, reset, cleaned, rebased, stashed, pulled, or used as launcher mirror storage.

Before an explicit version activation rebuilds the Launcher-owned Harness checkout, the launcher runs `git clean -xdf` in that verified checkout. This removes untracked and ignored dependency and build residue that can make the next selected revision fail its locked install or build. It does not reset tracked files, and it never runs in an unmanaged repository, native DSH home, plugin directory, preset directory, or settings directory.

Alternative considered: maintain a mutable clone and switch branches in place. Rejected because a branch update can alter the running source and makes rollback and ownership hard to prove.

### Decision: External executables are explicit identities

The user selects Git, Node.js, and pnpm with native file selection. Electron main canonicalizes each selected executable, probes it directly without a shell, records the required version identity, and rechecks that identity before use.

Git is required for remote and worktree operations. Node.js must satisfy the selected worktree's declared `engines.node`; pnpm must match its declared `packageManager` and use the selected lockfile. The launcher supplies an explicit working directory and controlled environment to every invocation. A missing declaration, mismatched version, changed executable, unavailable tool, or unexpected output blocks the operation without substitution.

Alternative considered: use `PATH`, Electron's Node runtime, Corepack, npm, or a system pnpm. Rejected because the same workspace could execute a different tool after a restart and failures would be hidden.

### Decision: DSH owns desktop plugins and Agent presets

Because the launcher starts the ordinary `web` profile, the profile it reads is the normal `$DSH_HOME/profiles/web` profile. `dsh plugin --profile web add <package>` remains the only plugin installation route, so the same profile manifest and `node_modules` are visible to terminal and Launcher-started runs. Authored Agent presets remain in `$DSH_HOME/.agent-presets`.

The Harness root contains the selected exact worktree, while the Settings root keeps Launcher catalog and preference records. A plugin or configuration generation is bound to the SHA it was prepared for. The launcher switches generations only after the child has stopped and preflight succeeds; it never lets one revision silently write another revision's generation.

The Launcher does not directly write either DSH-owned location. It may show their paths and read the selected profile, but DSH keeps its own format and lifecycle.

### Decision: Launch uses the standard `dsh web` command and its announced URL

The launcher starts the registered Node executable with the selected worktree's built `apps/cli/lib/bin.js` as `dsh web --no-open`, using the selected worktree as cwd. It passes no private descriptor and adds no profile flag, because the ordinary `web` profile is the only one this change can rely on.

Readiness comes from the child's own startup line, which prints the canonical loopback URL and may embed a session credential. The launcher parses exactly that URL, accepts it only when its scheme is http(s) and its host is loopback, and preserves it unmodified for the run page. Until that line appears the runtime stays `starting`; a successful spawn is not readiness.

The launcher never predicts the port. `dsh web` selects its own, and a guessed `127.0.0.1:3080` would both miss a non-default port and drop the credential, so a rebuilt address is rejected outright.

Alternative considered: a descriptor-bound, generation-fenced private child IPC handshake. It proves more — that the expected worktree, profile, and descriptor became active — but it requires a Harness-side `desktop` profile, descriptor parser, and IPC counterpart that do not exist, and the proposal forbids changing Harness in this change. Implementing it belongs to a separate change that owns both repositories; this change carries no unwired bridge scaffolding.

Alternative considered: HTTP polling of a guessed port. Rejected because it cannot distinguish this launcher's child from an unrelated local server and cannot recover the session credential.

### Decision: Electron process boundaries remain narrow

The renderer runs from the trusted `dsh-app://` origin with context isolation and sandboxing. Preload exposes named typed operations only. Electron main validates sender, workspace, root, executable, and runtime-generation identities, owns native dialogs and child processes, and never accepts renderer-provided arbitrary paths or commands.

The accepted child runtime is the only source of Harness client traffic. Bridge streams and lifecycle events are generation-fenced; a stopped or crashed child cannot affect a new runtime. Physical transport, protocol failure, and Harness business failure remain distinct user-visible states.

## Risks / Trade-offs

- [A Harness revision cannot use the stable native home] → block readiness with the reported incompatibility; never create or migrate a replacement home.
- [A branch or tag moves after observation] → retain the old immutable worktree and require explicit selection of the newly resolved SHA.
- [A selected executable changes after registration] → revalidate its canonical identity and block the operation.
- [A child crashes during a request] → withdraw its generation, retain bounded diagnostics, report potentially lost process-local work, and require user action plus new preflight.
- [A root becomes unreadable or changes identity] → enter an explicit blocked or recovery state without guessing a replacement path.

## Migration Plan

This is a pre-release format replacement. The launcher accepts only the four-root registry formats defined by this change. A persisted record that describes an unrecognized role, a launcher-managed `.dsh`, an unknown field, or an unsupported version is rejected and requires explicit fresh Launcher-root registration. Native Harness state is never part of that migration and remains untouched.
