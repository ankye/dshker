# Peer credential storage diagnostic

This test uses the real Electron `safeStorage` provider. It does not replace
Windows DPAPI testing, packaged application composition or enrollment trust
verification. Its certificate is a test-owned self-signed Ed25519 identity.

Build the test-only driver from the app root:

```sh
npx esbuild tests/runtime/peer-credentials-driver.ts --bundle --platform=node \
  --format=esm --external:electron --outfile=.run/peer-credentials-driver.mjs
```

Choose an empty absolute temporary directory and the absolute path of an
OpenSSL binary supporting Ed25519. Run the same driver in two separate Electron
processes using the same temporary directory:

```text
<electron> .run/peer-credentials-driver.mjs <temporary-root> create <openssl>
<electron> .run/peer-credentials-driver.mjs <temporary-root> readback <openssl>
```

`ELECTRON_RUN_AS_NODE` must be unset. The driver creates an isolated Electron
userData directory and settings root, never choosing a production user profile.
Output contains only classification, phase and pass/fail data, not credentials
or ciphertext. The temporary signing key is removed after creating the public
test certificate. Only public identity fields and the record revision are
retained in the readback oracle.

Assertions cover ciphertext-only storage, exact decrypt/readback, duplicate
creation, invalid key material, stale revision protection, successful update,
readback after process restart, corrupt-record rejection without auto-reset,
revision-fenced deletion and missing-record failure. Both phases passed locally
on macOS. The default system LibreSSL could not generate the required test
certificate; selecting an explicit Ed25519-capable OpenSSL is a test prerequisite,
not a production runtime dependency.

## Pending enrollment recovery

The same two-process driver now also verifies `prepareEnrollment`,
`loadPendingEnrollment`, explicit-format `loadRegistration` and
`completeEnrollment`. Before any token is consumed, the original request,
service/user/network identity and Ed25519 key can be stored as one encrypted
pending record. That record contains no password, enrollment token or guessed
device ID. The issued credential replaces the same file atomically only with
the expected revision, original key, user and name. Duplicate preparation cannot
overwrite either pending or issued identity; invalid completion leaves the
pending readback unchanged. State selection uses the persisted format, not a
failed-load fallback. Both phases passed with real macOS safeStorage.

This proves storage and transition behavior, not the full registration UI or
network-disconnection workflow. The main enrollment orchestration and Windows
DPAPI evidence remain required.
