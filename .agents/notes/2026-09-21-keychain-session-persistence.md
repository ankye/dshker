# macOS Keychain session persistence

## Finding

The restart login regression was below the renderer. The Go macOS secret provider
started `security add-generic-password -w` with a stdin pipe, but `dshkerd`
launched from Electron can still have a controlling terminal. `security` then
reads the password from `/dev/tty` and leaves the child blocked, so
`peer-user-session:<serviceId>` never receives its commit header. The next
launcher process correctly sees no persisted session and renders the login form.

## Fix and evidence

`networking/internal/secret/store_darwin.go` gives the Keychain child a new
session with `syscall.SysProcAttr{Setsid: true}`. `security` consumes the
provided stdin, while the secret remains out of argv. The macOS Keychain unit
suite, the real-core `secrets-core.test.ts` migration/restart cases, and the full
Go internal suite pass after rebuilding `build/p2p/darwin-arm64/dshkerd`.
