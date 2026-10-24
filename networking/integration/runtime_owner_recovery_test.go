package integration

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math/big"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/catalog"
	"github.com/ankye/dshker/networking/internal/remoteconnections"
	"github.com/ankye/dshker/networking/internal/runtimeowner"
)

// The owner and both core compositions are production binaries. An idle owner
// is killed only after its exact published OS identity has been verified. No
// DSH replacement process or coordinator response supplies recovery authority.
func TestProductionCoreRecoversExitedIdleRuntimeOwner(t *testing.T) {
	recoveryNamespace(t)
	binary := isolationCoreBinary(t)
	for _, mode := range []string{"desktop", "headless"} {
		t.Run(mode, func(t *testing.T) {
			data := recoverySeedRecords(t)
			config := runtimeowner.Config{
				Executable: binary, StateRoot: stateDirectoryForCLI(t),
				DataRoot: data.dataRoot, CatalogRoot: data.catalogRoot,
			}
			owner, err := runtimeowner.Open(context.Background(), config)
			must(t, err)
			oldAlive := true
			t.Cleanup(func() {
				if oldAlive {
					cleanup, cancel := context.WithTimeout(context.Background(), 20*time.Second)
					defer cancel()
					if err := owner.Shutdown(cleanup); err != nil {
						t.Errorf("test-owned original authority cleanup failed: %v", err)
					}
					_ = owner.Close()
				}
			})
			originalIdentity := owner.Identity()
			before := recoveryCaptureOwner(t, config.StateRoot)
			recoveryKillExactIdleOwner(t, config, owner)
			oldAlive = false

			for generation := 0; generation < 2; generation++ {
				core := isolationBootCore(t, binary, config.StateRoot, data.catalogRoot, mode, data.dataRoot)
				t.Cleanup(func() {
					if !core.stopped {
						recoveryStopCore(t, core)
					}
				})
				ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
				assertCoreVersion(t, callCore(t, ctx, core.peer, "core.version", struct{}{}))
				current, err := runtimeowner.InspectIdentity(config)
				must(t, err)
				if current == originalIdentity || current.Instance == originalIdentity.Instance {
					t.Fatal("recovery reused the exited authority identity")
				}
				raw := callCore(t, ctx, core.peer, "runtime.status", map[string]string{"subjectId": "subject_recovery"})
				var status struct {
					Present bool `json:"present"`
				}
				must(t, json.Unmarshal(raw, &status))
				if status.Present {
					t.Fatal("fresh recovered owner invented an existing DSH child")
				}
				data.assertReadback(t, ctx, core)
				recoveryAssertArchive(t, config.StateRoot, before)
				recoveryStopCore(t, core)
				cancel()
				if _, err := os.Stat(filepath.Join(config.StateRoot, "runtime-owner", "owner.json")); !os.IsNotExist(err) {
					t.Fatal("normal recovered-core exit retained an owner record")
				}
			}
		})
	}
}

func TestProductionRuntimeOwnerLiveReattachDoesNotArchive(t *testing.T) {
	recoveryNamespace(t)
	binary := isolationCoreBinary(t)
	config := runtimeowner.Config{Executable: binary, StateRoot: stateDirectoryForCLI(t)}
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	first, err := runtimeowner.Open(ctx, config)
	must(t, err)
	t.Cleanup(func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		if err := first.Shutdown(cleanup); err != nil {
			t.Errorf("test-owned live authority cleanup failed: %v", err)
		}
		_ = first.Close()
	})
	before := recoveryCaptureOwner(t, config.StateRoot)
	second, err := runtimeowner.Open(ctx, config)
	must(t, err)
	defer second.Close()
	if second.Created() || second.Identity() != first.Identity() {
		t.Fatal("live reattach replaced the original runtime authority")
	}
	current := recoveryCaptureOwner(t, config.StateRoot)
	if !bytes.Equal(before.record, current.record) || !bytes.Equal(before.journal, current.journal) {
		t.Fatal("live reattach mutated the current owner or its safety journal")
	}
	entries, err := os.ReadDir(filepath.Join(config.StateRoot, "runtime-owner", "archive"))
	if !os.IsNotExist(err) && err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatal("live reattach archived a running authority")
	}
}

type recoveryOwnerBytes struct{ record, journal []byte }

func recoveryCaptureOwner(t *testing.T, state string) recoveryOwnerBytes {
	t.Helper()
	directory := filepath.Join(state, "runtime-owner")
	record, err := os.ReadFile(filepath.Join(directory, "owner.json"))
	must(t, err)
	journal, err := os.ReadFile(filepath.Join(directory, "recovery.json"))
	must(t, err)
	var safety struct {
		Phase string `json:"phase"`
	}
	must(t, json.Unmarshal(journal, &safety))
	if safety.Phase != "idle" {
		t.Fatal("production owner did not durably certify its idle state")
	}
	return recoveryOwnerBytes{record: record, journal: journal}
}

func recoveryKillExactIdleOwner(t *testing.T, config runtimeowner.Config, owner *runtimeowner.Client) {
	t.Helper()
	identity, err := runtimeowner.InspectIdentity(config)
	must(t, err)
	if identity != owner.Identity() || identity.PID <= 0 {
		t.Fatal("test-owned runtime authority identity changed before fault injection")
	}
	process, err := os.FindProcess(identity.PID)
	must(t, err)
	must(t, process.Kill())
	_ = process.Release()
	must(t, owner.Close())
	deadline := time.Now().Add(5 * time.Second)
	for {
		_, err := runtimeowner.InspectIdentity(config)
		if errors.Is(err, runtimeowner.ErrOwnerUnavailable) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("the exact test-owned runtime authority did not exit")
		}
		time.Sleep(time.Millisecond)
	}
}

func recoveryAssertArchive(t *testing.T, state string, original recoveryOwnerBytes) {
	t.Helper()
	root := filepath.Join(state, "runtime-owner", "archive")
	entries, err := os.ReadDir(root)
	must(t, err)
	if len(entries) != 1 || !entries[0].IsDir() || entries[0].Type()&os.ModeSymlink != 0 {
		t.Fatal("recovery must preserve exactly one private archive directory")
	}
	archive := filepath.Join(root, entries[0].Name())
	for name, expected := range map[string][]byte{"owner.json": original.record, "recovery.json": original.journal} {
		actual, err := os.ReadFile(filepath.Join(archive, name))
		must(t, err)
		if !bytes.Equal(actual, expected) {
			t.Fatalf("archive did not preserve exact original %s bytes", name)
		}
	}
}

func recoveryStopCore(t *testing.T, core *isolationCore) {
	t.Helper()
	if core.stopped {
		return
	}
	if !core.headless {
		core.stop(t)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	callCore(t, ctx, core.peer, "core.desktop_attach", struct{}{})
	callCore(t, ctx, core.peer, "core.desktop_handoff", struct{}{})
	core.peer.Close()
	select {
	case err := <-core.done:
		core.stopped = true
		if err != nil {
			t.Fatalf("recovered headless core did not exit normally: %v", err)
		}
	case <-ctx.Done():
		t.Fatal("recovered headless core did not join its owner on normal handoff")
	}
}

func recoveryNamespace(t *testing.T) {
	t.Helper()
	identity := sha256.Sum256([]byte(t.TempDir()))
	t.Setenv("DSHKER_SECRET_NAMESPACE", "regression-owner-recovery-"+hex.EncodeToString(identity[:]))
}

type recoveryRecords struct {
	catalogRoot, dataRoot, remotePath string
	catalog                           catalog.Snapshot
	remote                            []remoteconnections.Computer
	files                             map[string][sha256.Size]byte
}

// These are real persisted product records with newly generated test-owned
// identities. The preserved pair starts revoked, so absence of a login must not
// create authority or rewrite it during the runtime-only recovery.
func recoverySeedRecords(t *testing.T) recoveryRecords {
	t.Helper()
	root, dataRoot := t.TempDir(), t.TempDir()
	store, err := catalog.Open(root)
	must(t, err)
	initial, err := store.Enable()
	must(t, err)
	service := recoveryService(t)
	local, _, err := ed25519.GenerateKey(rand.Reader)
	must(t, err)
	remote, _, err := ed25519.GenerateKey(rand.Reader)
	must(t, err)
	next := initial.Record
	next.Services = []catalog.Service{service}
	next.Computers = []catalog.Computer{{
		ConnectionID: recoveryID(t), ServiceID: service.ServiceID, DisplayName: "Original paired computer",
		PairID: recoveryID(t), NetworkID: recoveryID(t), LocalDeviceID: recoveryID(t),
		RemoteDeviceID: recoveryID(t), UserID: recoveryID(t), LocalPublicKey: base64.StdEncoding.EncodeToString(local),
		RemotePublicKey: base64.StdEncoding.EncodeToString(remote), PairRevision: 7, PairState: "revoked",
	}}
	snapshot, err := store.Commit(initial.Revision, next)
	must(t, err)
	remotePath := filepath.Join(root, remoteconnections.FileName)
	remotes, err := remoteconnections.Open(remotePath)
	must(t, err)
	computers, err := remotes.Create("Original SSH computer", "original.example", 2222, "original-user", "")
	must(t, err)
	files := map[string][sha256.Size]byte{}
	for _, name := range []string{"p2p-devices.json", "p2p-enabled.json", remoteconnections.FileName} {
		raw, err := os.ReadFile(filepath.Join(root, name))
		must(t, err)
		files[name] = sha256.Sum256(raw)
	}
	return recoveryRecords{catalogRoot: root, dataRoot: dataRoot, remotePath: remotePath, catalog: snapshot, remote: computers, files: files}
}

func (records recoveryRecords) assertReadback(t *testing.T, ctx context.Context, core *isolationCore) {
	t.Helper()
	var catalogReply struct {
		Enabled  bool           `json:"enabled"`
		Revision string         `json:"revision"`
		Record   catalog.Record `json:"record"`
	}
	must(t, json.Unmarshal(callCore(t, ctx, core.peer, "core.catalog_inspect", struct{}{}), &catalogReply))
	if !catalogReply.Enabled || catalogReply.Revision != records.catalog.Revision || !reflect.DeepEqual(catalogReply.Record, records.catalog.Record) {
		t.Fatal("runtime recovery changed the original account, network, pair, device or key identity")
	}
	var remoteReply struct {
		Connections []remoteconnections.Computer `json:"connections"`
	}
	must(t, json.Unmarshal(callCore(t, ctx, core.peer, "remote.catalog_inspect", map[string]string{"filePath": records.remotePath}), &remoteReply))
	if !reflect.DeepEqual(remoteReply.Connections, records.remote) {
		t.Fatal("runtime recovery changed the original SSH record")
	}
	for name, expected := range records.files {
		raw, err := os.ReadFile(filepath.Join(records.catalogRoot, name))
		must(t, err)
		if sha256.Sum256(raw) != expected {
			t.Fatalf("runtime-only recovery mutated preserved %s", name)
		}
	}
}

func recoveryService(t *testing.T) catalog.Service {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	must(t, err)
	digest := sha256.Sum256(public)
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "Owner recovery regression"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign,
	}
	certificate, err := x509.CreateCertificate(rand.Reader, template, template, public, private)
	must(t, err)
	return catalog.Service{
		ServiceID: hex.EncodeToString(digest[:6]), DisplayName: "Original coordinator",
		HTTPSOrigin: "https://127.0.0.1:1", WSSURL: "wss://127.0.0.1:1/v1/signals", STUNAddress: "127.0.0.1:1",
		PublicKey: base64.StdEncoding.EncodeToString(public), Certificate: base64.StdEncoding.EncodeToString(certificate),
	}
}

func recoveryID(t *testing.T) string {
	t.Helper()
	var value [6]byte
	_, err := rand.Read(value[:])
	must(t, err)
	return hex.EncodeToString(value[:])
}
