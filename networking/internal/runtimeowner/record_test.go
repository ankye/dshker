package runtimeowner

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func pendingRecord(t *testing.T, config Config) (string, ownerRecord) {
	t.Helper()
	record, err := configRecord(config)
	if err != nil {
		t.Fatal(err)
	}
	directory := filepath.Join(record.Config.StateRoot, ownerDirectory)
	if err := privateDirectory(directory); err != nil {
		t.Fatal(err)
	}
	record.Instance, err = randomHex(16)
	if err != nil {
		t.Fatal(err)
	}
	record.Token, err = randomHex(32)
	if err != nil {
		t.Fatal(err)
	}
	record.Socket, record.SocketDirectory, err = ownerSocket(directory)
	if err != nil {
		t.Fatal(err)
	}
	if record.SocketDirectory != "" {
		t.Cleanup(func() { os.Remove(record.SocketDirectory) })
	}
	path := filepath.Join(directory, recordFileName)
	if err := writeRecord(path, record); err != nil {
		t.Fatal(err)
	}
	return path, record
}

func TestOwnerRecordsRefuseCorruptionProtocolAndCrossRoot(t *testing.T) {
	for _, name := range []string{"corrupt", "protocol", "cross-root", "executable-digest", "roots-digest", "home-context"} {
		t.Run(name, func(t *testing.T) {
			config := ownerTestConfig(t)
			path, record := pendingRecord(t, config)
			want := ErrOwnerIdentityMismatch
			switch name {
			case "corrupt":
				if err := os.WriteFile(path, []byte(`{"invalid":true}`), 0o600); err != nil {
					t.Fatal(err)
				}
				want = ErrOwnerRecordInvalid
			case "protocol":
				record.Version++
				want = ErrOwnerProtocol
			case "cross-root":
				record.Config.DataRoot = record.Config.StateRoot
			case "executable-digest":
				record.ExecutableHash = strings.Repeat("a", 64)
			case "roots-digest":
				record.RootsHash = strings.Repeat("a", 64)
			case "home-context":
				record.Home.Digest = strings.Repeat("a", 64)
			}
			if name != "corrupt" {
				if err := writeRecord(path, record); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := Open(context.Background(), config); !errors.Is(err, want) {
				t.Fatalf("owner record %s was replaced, guessed, or accepted: %v", name, err)
			}
			if _, err := os.Stat(path); err != nil {
				t.Fatal("refused owner record was silently deleted")
			}
		})
	}
}

func TestOwnerHomeFingerprintTracksAllNativeHomeInputs(t *testing.T) {
	for _, key := range []string{"DSH_HOME", "HOME", "USERPROFILE"} {
		t.Run(key, func(t *testing.T) {
			t.Setenv(key, "explicit-home-one")
			before := inheritedHome()
			t.Setenv(key, "explicit-home-two")
			after := inheritedHome()
			if before == after {
				t.Fatalf("owner home context ignored %s value", key)
			}
			if err := os.Unsetenv(key); err != nil {
				t.Fatal(err)
			}
			absent := inheritedHome()
			t.Setenv(key, "")
			if absent == inheritedHome() {
				t.Fatalf("owner home context conflated missing and empty %s", key)
			}
			encoded, err := json.Marshal(before)
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(string(encoded), "explicit-home-one") {
				t.Fatal("owner record persisted raw inherited environment")
			}
		})
	}
}

func TestOwnerConfigurationNormalizesPrefixButRejectsFinalLink(t *testing.T) {
	config := ownerTestConfig(t)
	record, err := configRecord(config)
	if err != nil {
		t.Fatal(err)
	}
	canonical, err := filepath.EvalSymlinks(config.StateRoot)
	if err != nil {
		t.Fatal(err)
	}
	if record.Config.StateRoot != canonical {
		t.Fatal("explicit state prefix alias was not normalized consistently")
	}
	if runtime.GOOS == "windows" {
		return
	} // Windows reparse coverage is a separate platform test.
	link := filepath.Join(config.StateRoot, "selected-link")
	if err := os.Symlink(config.StateRoot, link); err != nil {
		t.Fatal(err)
	}
	config.DataRoot = link
	if _, err := configRecord(config); !errors.Is(err, ErrOwnerConfiguration) {
		t.Fatalf("final selected symlink was accepted as a root: %v", err)
	}
}

func TestOwnerSocketDoesNotDependOnLongStateRoot(t *testing.T) {
	config := ownerTestConfig(t)
	for range 4 {
		config.StateRoot = filepath.Join(config.StateRoot, strings.Repeat("long-state-", 8))
		if err := os.Mkdir(config.StateRoot, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	_, record := pendingRecord(t, config)
	if err := validateOwnerEndpoint(record); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && len(record.Socket) >= 104 {
		t.Fatal("runtime owner socket inherited an overlong core state path")
	}
}
