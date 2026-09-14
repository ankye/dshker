package installcatalog

import (
	"strings"
	"testing"
)

// TestParsePinsTheFingerprintTimeContract is the interop rule for the two
// fingerprint shapes' time fields: they are whole milliseconds, because that is
// what both implementations store and what the core decodes as an integer.
//
// The shell's stat reports a fractional number of milliseconds on any filesystem
// with sub-millisecond timestamps (APFS, ext4, NTFS), so a shell that passed the
// raw value through would produce a catalog this side cannot read — and the
// shell's own record validation, which requires a safe integer, would not read it
// either. That is why the golden below is edited rather than trusted: the
// captured document uses small hand-written integers, so on its own it proves the
// encoder round-trips and says nothing about the values a real stat produces.
func TestParsePinsTheFingerprintTimeContract(t *testing.T) {
	whole := strings.Replace(shellGolden, `"modifiedAtMilliseconds": 4`, `"modifiedAtMilliseconds": 1789354676388`, 1)
	if whole == shellGolden {
		t.Fatal("the golden no longer carries the Git fingerprint this test edits")
	}
	if _, err := Parse([]byte(whole)); err != nil {
		t.Fatalf("whole milliseconds were refused: %v", err)
	}
	fractional := strings.Replace(shellGolden, `"modifiedAtMilliseconds": 4`, `"modifiedAtMilliseconds": 1789354676388.1973`, 1)
	if _, err := Parse([]byte(fractional)); err == nil {
		t.Fatal("a fractional millisecond was accepted, so the two sides no longer agree")
	}
}
