# DSHKer Launcher usage guide

## Before you begin

Install the macOS arm64 or Windows x64 package from the repository's [latest GitHub Release](https://github.com/ankye/dshker/releases/latest). The current packages are unsigned; verify the installer against `checksums.txt`, run it manually, and keep your native DSH data backed up as you normally would. GitHub Actions artifacts are short-lived build evidence, not the Launcher update feed.

DSHKer Launcher does not take ownership of `$DSH_HOME` or `~/.dsh`. Do not move that directory into `~/.dshlauncher`, and do not delete it when switching versions.

## Start DSH for the first time

1. Open **DSHKer Launcher**.
2. Stay on **Launch** while the packaged Harness seed prepares in the background. The splash page remains interactive and the start button stays disabled until the core is ready.
3. When the selected version card appears, review its DSH commit and choose **Launch**.
4. The application changes to **Console** so you can follow the exact command and its real-time output.
5. Once DSH announces a loopback URL, open **Run** and add a tab. The Launcher uses that announced address exactly; it does not guess a port.

## Change or update the core

1. Open **Version management → Core**.
2. Choose **Refresh list** to fetch the configured HTTPS origin and rebuild the displayed commit and tag list. Refresh does not switch versions or restart DSH.
3. Stop DSH Web before selecting **Update**, a branch, or a commit row.
4. Wait for dependency installation and the DSH build to finish. The selected version changes only after that preparation succeeds.

The selected core lives at `~/.dshlauncher/harness`. It is Git-managed by Launcher; do not edit, clean, reset, or switch it from another Git client while it is active.

## Manage extensions

- **Version management → Extensions** lists the web-profile dependencies that DSH reports as installed.
- **Install extension** reads the curated `awesome-dsh-plugin` catalog from `~/.dshlauncher/plugins`.
- Installing or removing an extension forwards to the standard DSH CLI. Launcher does not write DSH profile manifests or native plugin directories directly.
- Stop DSH Web before changing extensions.

## Check for a new Launcher version

1. Open **Settings → Launcher settings → Updates**.
2. Choose **Check again**. The page moves from checking to either up to date, update available, or an explicit failed state.
3. If an update is available, confirm the reported stable version and installer name, then choose **Download**.
4. The system browser opens the exact GitHub Release asset for macOS arm64 or Windows x64. Verify `checksums.txt` on the Release page and run the installer manually.

The Launcher also performs the same fixed-repository check after startup without delaying the main window. It displays a startup notice only for a higher stable semantic version. A failed startup check does not open a warning dialog; Settings retains the failure state so you can retry. If GitHub has no public latest Release, or if the required asset is missing or duplicated, the check fails explicitly and does not substitute an Actions artifact or another platform package.

## Use Console and Run

Console separates Launcher lifecycle messages, the launch command, standard output, and standard error. Use its bottom action to start or stop the exact process Launcher created. The log file is stored in `~/.dshlauncher/logs/dsh-web.log`; you can reveal or export it from Console.

Run contains browser-like tabs for the DSH Web address announced by the managed process. Closing a Run tab never stops DSH. Stopping DSH withdraws its Run pages because a later process must announce a new address.

## Troubleshooting

| Symptom                          | What to do                                                                                         |
| -------------------------------- | -------------------------------------------------------------------------------------------------- |
| The start button is disabled     | Wait for the first bundled-core preparation to finish, then refresh Launch.                        |
| A version operation is refused   | Stop DSH Web in Launch or Console before switching core versions or extensions.                    |
| DSH does not become ready        | Open Console and inspect the process output and the exported log; Launcher does not assume a port. |
| The Harness directory is invalid | Check `~/.dshlauncher/harness` in Launcher settings. Do not replace `~/.dsh` to repair it.         |
| An extension change fails        | Review Console output. The existing DSH extension list remains unchanged on failure.               |
| Launcher update check fails      | Retry from Settings. Confirm GitHub Releases has one exact installer for your platform.            |

## Open source and support

Use the source controls on Launch or these links:

- [DSHKer Launcher issues and source](https://github.com/ankye/dshker)
- [DeepSeek Harness source](https://github.com/deepseek-ai/deepseek-harness)
