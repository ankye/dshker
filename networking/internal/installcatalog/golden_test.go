package installcatalog

import _ "embed"

// shellGolden is one catalog exactly as the TypeScript shell persisted it,
// captured from the shell's own encoder. It is the interop contract: the core
// must accept these bytes and reproduce them unchanged on a save, otherwise a
// write/read handoff between the two implementations would rewrite the file on
// every launch. It lives in testdata/ so the core's own test can read the same
// bytes instead of keeping a second copy.
//
//go:embed testdata/managed-installation-catalog.json
var shellGolden string
