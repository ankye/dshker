package integration

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// A supplied candidate is an explicit alternative test input, never a fallback
// for a failed source build. Supplying either field requires both and refuses
// before starting a process when the exact regular file/digest is not admitted.
func coreDaemonBinaryForTest(t *testing.T) string {
	t.Helper()
	binary, suppliedBinary := os.LookupEnv("DSHKER_TEST_CORE_BINARY")
	digest, suppliedDigest := os.LookupEnv("DSHKER_TEST_CORE_SHA256")
	if suppliedBinary || suppliedDigest {
		must(t, coreValidatePrebuiltBinary(binary, digest))
		return binary
	}
	binary = filepath.Join(t.TempDir(), "dshkerd")
	if runtime.GOOS == "windows" {
		binary += ".exe"
	}
	build := exec.Command("go", "build", "-buildvcs=false", "-o", binary, corePackage)
	build.Stderr = os.Stderr
	must(t, build.Run())
	return binary
}

func coreValidatePrebuiltBinary(binary, expected string) error {
	if !filepath.IsAbs(binary) || len(expected) != sha256.Size*2 || strings.ToLower(expected) != expected {
		return errors.New("test.prebuilt_core_input_invalid")
	}
	if _, err := hex.DecodeString(expected); err != nil {
		return errors.New("test.prebuilt_core_input_invalid")
	}
	info, err := os.Lstat(binary)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("test.prebuilt_core_file_invalid")
	}
	data, err := os.ReadFile(binary)
	if err != nil {
		return errors.New("test.prebuilt_core_read_failed")
	}
	actual := sha256.Sum256(data)
	if hex.EncodeToString(actual[:]) != expected {
		return errors.New("test.prebuilt_core_digest_mismatch")
	}
	return nil
}

func TestCorePrebuiltBinaryRequiresExactExplicitRegularFileAndDigest(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "candidate-core")
	data := []byte("test input only, never executed")
	must(t, os.WriteFile(path, data, 0o600))
	hash := sha256.Sum256(data)
	digest := hex.EncodeToString(hash[:])
	cases := []string{"valid", "missing-path", "relative", "missing-digest", "bad-hex", "uppercase", "wrong-digest", "missing-file", "directory"}
	// Actual symbolic-link creation is a Unix filesystem case. Windows requires
	// an OS privilege for creating one which the test must not acquire or change.
	if runtime.GOOS != "windows" {
		cases = append(cases, "symlink")
	}
	for _, name := range cases {
		t.Run(name, func(t *testing.T) {
			binary, expected := path, digest
			switch name {
			case "missing-path":
				binary = ""
			case "relative":
				binary = "candidate-core"
			case "missing-digest":
				expected = ""
			case "bad-hex":
				expected = strings.Repeat("z", 64)
			case "uppercase":
				expected = strings.ToUpper(expected)
			case "wrong-digest":
				expected = strings.Repeat("0", 64)
			case "missing-file":
				binary = filepath.Join(directory, "absent")
			case "directory":
				binary = directory
			case "symlink":
				binary = filepath.Join(directory, "link")
				must(t, os.Symlink(path, binary))
			}
			err := coreValidatePrebuiltBinary(binary, expected)
			if name == "valid" && err != nil || name != "valid" && err == nil {
				t.Fatal("explicit candidate admission changed", err)
			}
		})
	}
}
