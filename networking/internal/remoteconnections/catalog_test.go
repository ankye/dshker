package remoteconnections

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// shellGolden is the catalog exactly as the TypeScript shell encoded it, and the
// two configuration revisions it derived. It is the interop contract: the core
// must accept these bytes, reproduce them on a save, and compute the same
// revision the shell uses to refuse a stale edit.
const shellGolden = `{
  "format": "dsh-launcher.remote-connections",
  "version": 1,
  "connections": [
    {
      "connectionId": "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      "displayName": "Build box",
      "host": "build.example",
      "port": 22,
      "user": "deploy"
    },
    {
      "connectionId": "9c858901-8a57-4791-81fe-4c455b099bc9",
      "displayName": "CI runner",
      "host": "10.147.17.110",
      "port": 2222,
      "user": "administrator"
    }
  ]
}
`

const (
	goldenFirstRevision  = "1cb5c217e26101ff4eed360b988bdd23d6b672f718ec0b20ae2f629970296985"
	goldenSecondRevision = "be022a1a4a73dc9bb747f127b8ec818a65f38bdd5af687e15ab53733cbc9e49f"
)

// storeIn returns a store inside a private directory the listener accepts.
func storeIn(t *testing.T) (*Store, string) {
	t.Helper()
	directory := t.TempDir()
	launcherDirectory := filepath.Join(directory, "dsh-launcher")
	if err := os.MkdirAll(launcherDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	store, err := Open(filepath.Join(launcherDirectory, FileName))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	return store, launcherDirectory
}

// TestShellGoldenRoundTripsAndKeepsItsRevision pins both halves of the contract.
func TestShellGoldenRoundTripsAndKeepsItsRevision(t *testing.T) {
	store, directory := storeIn(t)
	if err := os.WriteFile(filepath.Join(directory, FileName), []byte(shellGolden), 0o600); err != nil {
		t.Fatal(err)
	}
	record, err := store.Load()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if len(record.Connections) != 2 {
		t.Fatalf("record = %+v", record)
	}
	if ConfigRevision(record.Connections[0]) != goldenFirstRevision ||
		ConfigRevision(record.Connections[1]) != goldenSecondRevision {
		t.Fatalf("revisions = %s %s", ConfigRevision(record.Connections[0]), ConfigRevision(record.Connections[1]))
	}
	encoded, err := Encode(record)
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != shellGolden {
		t.Fatalf("encoded bytes differ from the shell:\n%s", encoded)
	}
}

// TestFirstReadPublishesAnEmptyCatalog covers the shell's own behaviour: the
// remote page is an invitation before it is a document.
func TestFirstReadPublishesAnEmptyCatalog(t *testing.T) {
	store, directory := storeIn(t)
	record, err := store.Load()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if record.Format != Format || record.Version != Version || len(record.Connections) != 0 {
		t.Fatalf("record = %+v", record)
	}
	if _, err := os.Stat(filepath.Join(directory, FileName)); err != nil {
		t.Fatalf("the empty catalog was not published: %v", err)
	}
}

// TestCreateUpdateAndRemoveKeepTheRevisionContract drives the three mutations.
func TestCreateUpdateAndRemoveKeepTheRevisionContract(t *testing.T) {
	store, _ := storeIn(t)
	if _, err := store.Load(); err != nil {
		t.Fatal(err)
	}
	connections, err := store.Create("Build box", "build.example", 22, "deploy")
	if err != nil || len(connections) != 1 {
		t.Fatalf("create = %+v, %v", connections, err)
	}
	// A name that differs only in case is the same name to the page.
	if _, err := store.Create("build BOX", "other.example", 22, "deploy"); !errors.Is(err, ErrExists) {
		t.Fatalf("duplicate name = %v", err)
	}
	created := connections[0]
	if _, err := store.Update(created.ConnectionID, "Build box two", "build.example", 2222, "deploy", "not-the-revision"); !errors.Is(err, ErrConfigConflict) {
		t.Fatalf("stale revision = %v", err)
	}
	updated, err := store.Update(created.ConnectionID, "Build box two", "build.example", 2222, "deploy", ConfigRevision(created))
	if err != nil || updated[0].DisplayName != "Build box two" || updated[0].Port != 2222 {
		t.Fatalf("update = %+v, %v", updated, err)
	}
	if updated[0].ConnectionID != created.ConnectionID {
		t.Fatal("update changed the identity")
	}
	if _, err := store.Update("3f2504e0-4f89-41d3-9a0c-0305e82c3302", "Other", "h", 22, "u", "x"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown identity = %v", err)
	}
	if _, err := store.Remove(created.ConnectionID); err != nil {
		t.Fatalf("remove: %v", err)
	}
	if _, err := store.Remove(created.ConnectionID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second remove = %v", err)
	}
}

// TestParseRefusesEveryBrokenShape covers the strict document rules.
func TestParseRefusesEveryBrokenShape(t *testing.T) {
	for name, document := range map[string]string{
		"not json":              "{",
		"an array":              "[]",
		"a top-level field":     `{"format":"dsh-launcher.remote-connections","version":1,"connections":[],"extra":1}`,
		"a missing field":       `{"format":"dsh-launcher.remote-connections","version":1}`,
		"another format":        `{"format":"other","version":1,"connections":[]}`,
		"another version":       `{"format":"dsh-launcher.remote-connections","version":2,"connections":[]}`,
		"entries not an array":  `{"format":"dsh-launcher.remote-connections","version":1,"connections":{}}`,
		"an entry field":        `{"format":"dsh-launcher.remote-connections","version":1,"connections":[{"connectionId":"3f2504e0-4f89-41d3-9a0c-0305e82c3301","displayName":"a","host":"h","port":22,"user":"u","extra":1}]}`,
		"a missing entry field": `{"format":"dsh-launcher.remote-connections","version":1,"connections":[{"connectionId":"3f2504e0-4f89-41d3-9a0c-0305e82c3301","displayName":"a","host":"h","port":22}]}`,
		"a non uuid identity":   `{"format":"dsh-launcher.remote-connections","version":1,"connections":[{"connectionId":"nope","displayName":"a","host":"h","port":22,"user":"u"}]}`,
		"an untrimmed name":     `{"format":"dsh-launcher.remote-connections","version":1,"connections":[{"connectionId":"3f2504e0-4f89-41d3-9a0c-0305e82c3301","displayName":" a","host":"h","port":22,"user":"u"}]}`,
		"a leading hyphen host": `{"format":"dsh-launcher.remote-connections","version":1,"connections":[{"connectionId":"3f2504e0-4f89-41d3-9a0c-0305e82c3301","displayName":"a","host":"-h","port":22,"user":"u"}]}`,
		"a port zero":           `{"format":"dsh-launcher.remote-connections","version":1,"connections":[{"connectionId":"3f2504e0-4f89-41d3-9a0c-0305e82c3301","displayName":"a","host":"h","port":0,"user":"u"}]}`,
		"an invalid user":       `{"format":"dsh-launcher.remote-connections","version":1,"connections":[{"connectionId":"3f2504e0-4f89-41d3-9a0c-0305e82c3301","displayName":"a","host":"h","port":22,"user":"-u"}]}`,
		"a duplicate identity":  `{"format":"dsh-launcher.remote-connections","version":1,"connections":[{"connectionId":"3f2504e0-4f89-41d3-9a0c-0305e82c3301","displayName":"a","host":"h","port":22,"user":"u"},{"connectionId":"3f2504e0-4f89-41d3-9a0c-0305e82c3301","displayName":"b","host":"h","port":22,"user":"u"}]}`,
		"a duplicate name":      `{"format":"dsh-launcher.remote-connections","version":1,"connections":[{"connectionId":"3f2504e0-4f89-41d3-9a0c-0305e82c3301","displayName":"Same","host":"h","port":22,"user":"u"},{"connectionId":"9c858901-8a57-4791-81fe-4c455b099bc9","displayName":"SAME","host":"h","port":22,"user":"u"}]}`,
	} {
		t.Run(name, func(t *testing.T) {
			_, err := Parse([]byte(document))
			if !errors.Is(err, ErrInvalidRecord) && !errors.Is(err, ErrUnsupportedVersion) {
				t.Fatalf("%s = %v", name, err)
			}
		})
	}
}

func TestParseReportsAnUnsupportedVersionByName(t *testing.T) {
	_, err := Parse([]byte(`{"format":"dsh-launcher.remote-connections","version":9,"connections":[]}`))
	if !errors.Is(err, ErrUnsupportedVersion) {
		t.Fatalf("version = %v", err)
	}
}

func TestOpenOwnsExactlyOneFile(t *testing.T) {
	base := t.TempDir()
	for name, path := range map[string]string{
		"another file name": filepath.Join(base, "connections.json"),
		"a relative path":   FileName,
		"an empty path":     "",
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := Open(path); !errors.Is(err, ErrPersistenceFailed) {
				t.Fatalf("Open(%q) = %v", path, err)
			}
		})
	}
}

// TestStoreRefusesASymbolicLinkAndAMissingDirectory keeps the write honest.
func TestStoreRefusesASymbolicLinkAndAMissingDirectory(t *testing.T) {
	store, directory := storeIn(t)
	if _, err := store.Load(); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(directory, FileName)
	if err := os.Remove(link); err != nil {
		t.Fatal(err)
	}
	elsewhere := filepath.Join(t.TempDir(), FileName)
	if err := os.WriteFile(elsewhere, []byte(shellGolden), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(elsewhere, link); err != nil {
		t.Skipf("this filesystem cannot create a symlink: %v", err)
	}
	if _, err := store.Load(); !errors.Is(err, ErrPersistenceFailed) {
		t.Fatalf("symlinked load = %v", err)
	}
	if _, err := store.Create("x", "h", 22, "u"); !errors.Is(err, ErrPersistenceFailed) {
		t.Fatalf("symlinked save = %v", err)
	}
	missing := filepath.Join(t.TempDir(), "absent", FileName)
	absent, err := Open(missing)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := absent.Load(); !errors.Is(err, ErrPersistenceFailed) {
		t.Fatalf("missing directory = %v", err)
	}
}

func TestEncodingRefusesAnInvalidRecord(t *testing.T) {
	if _, err := Encode(Record{Format: Format, Version: Version, Connections: []Computer{{ConnectionID: "nope"}}}); !errors.Is(err, ErrInvalidRecord) {
		t.Fatalf("encode = %v", err)
	}
	if _, err := Encode(Record{Format: "other", Version: Version, Connections: []Computer{}}); !errors.Is(err, ErrInvalidRecord) {
		t.Fatalf("format = %v", err)
	}
}

func TestFilePathInsideNamesTheOneLocation(t *testing.T) {
	path := FilePathInside("/settings")
	if !strings.HasSuffix(path, filepath.Join("dsh-launcher", FileName)) {
		t.Fatalf("path = %s", path)
	}
}
