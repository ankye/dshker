# DSHKer Launcher usage guide

## Before you begin

Install a macOS arm64 or Windows x64 artifact from the repository's GitHub Actions package workflow. The current artifacts are unsigned build evidence, not a signed public release. Verify `checksums.txt` before opening an installer and keep your native DSH data backed up as you normally would.

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

## Use Console and Run

Console separates Launcher lifecycle messages, the launch command, standard output, and standard error. Use its bottom action to start or stop the exact process Launcher created. The log file is stored in `~/.dshlauncher/logs/dsh-web.log`; you can reveal or export it from Console.

Run contains browser-like tabs for the DSH Web address announced by the managed process. Closing a Run tab never stops DSH. Stopping DSH withdraws its Run pages because a later process must announce a new address.

## Troubleshooting

| Symptom                          | What to do                                                                                         |
| -------------------------------- | -------------------------------------------------------------------------------------------------- |
| The start button is disabled     | Wait for the first bundled-core preparation to finish, then refresh Launch.                        |
| A version operation is refused   | Stop DSH Web in Launch or Console before switching core versions or extensions.                    |
| DSH does not become ready        | Open Console and inspect the process output and the exported log; Launcher does not assume a port. |
| The Harness directory is invalid | Check `~/.dshlauncher/harness` in Advanced. Do not replace `~/.dsh` to repair it.                  |
| An extension change fails        | Review Console output. The existing DSH extension list remains unchanged on failure.               |

## Open source and support

Use the source controls on Launch or these links:

- [DSHKer Launcher issues and source](https://github.com/ankye/dshker)
- [DeepSeek Harness source](https://github.com/deepseek-ai/deepseek-harness)
