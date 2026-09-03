# Managed plugin source installation

DSHKer materializes every plugin source below `~/.dshlauncher/plugins/managed-sources` before calling `dsh plugin --profile web`. A native-picked local directory is copied; an HTTPS Git repository is cloned. A GitHub catalog tree URL clones its repository and installs the named package child directory.

`sources.json` maps a DSH-installed package name to the exact Launcher-owned root. Uninstall calls the DSH CLI first and removes only the mapped root after that command succeeds. Source records are validated as descendants of the managed-sources root before removal, so a malformed record cannot target an arbitrary directory.

If DSH accepts the plugin but the Launcher cannot refresh or persist its mapping afterward, the source directory is retained. Removing it would leave the native DSH profile pointing at a missing `file:` dependency.

Verification on 2026-09-03 used `@deepseek-ai/dsh-tool-vision`: its GitHub catalog tree source cloned to the managed root and installed through the live DSHKer IPC; its local directory copied to the managed root through the service; both paths uninstalled cleanly and left `sources.json` empty. A DSHKer start-to-stop smoke also succeeded against managed Harness commit `db6bdc3576c2d4e7c965e8e3ed0c2a731eed87f5` after the incompatible pre-existing user plugin was removed through DSHKer.

Git records use format version 2 and persist clone URL, branch, package path, and exact commit. The Extensions list is projected only from `~/.dsh/profiles/web`; `managed-sources` is source storage for comparison and update, never a second installed-extension list. Companion runtime and settings packages from one source are one extension row. The two separate in-box packages, `dsh-base` and `dsh-web-app`, are mandatory Web runtime components, not user extensions.

Update fetches the declared branch, stores the checked-out commit, and forwards `dsh plugin --profile web update <package>`. A legacy `file:` package may be explicitly moved under management only when its current local GitHub checkout yields an exact selected branch and a package-relative path. DSHKer clones that child source, updates the native profile through `dsh plugin add`, and records it; it never edits the external checkout. A 2026-09-03 run confirmed the managed lifecycle for `@deepseek-ai/dsh-tool-vision`; its source updated correctly, but the plugin itself remained incompatible with the selected Harness `dsh-settings` exports and was removed through DSHKer before the final successful core launch smoke.

Refresh fetches only DSHKer-managed plugin sources and records whether each declared branch has a newer commit. Update is disabled when no source reports a newer commit. Manage and Update remain distinct: an unmanaged local GitHub source shows only its active Manage action; after management succeeds, Manage disappears and Refresh determines whether Update is enabled.
