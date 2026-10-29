package integration

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/catalog"
	"github.com/ankye/dshker/networking/internal/localrpc"
	"github.com/ankye/dshker/networking/internal/remoteconnections"
	"github.com/ankye/dshker/networking/internal/runtimeowner"
)

// Exercise both actual production compositions against the same abandoned or
// incompatible authority that used to prevent all core services from booting.
// No replacement owner, synthetic runtime or coordinator is provided.
func TestRuntimeOwnerRefusalDoesNotDisableCoreServices(t *testing.T) {
	identity := sha256.Sum256([]byte(t.TempDir()))
	t.Setenv("DSHKER_SECRET_NAMESPACE", "regression-runtime-"+hex.EncodeToString(identity[:]))
	binary := isolationCoreBinary(t)
	other := filepath.Join(t.TempDir(), filepath.Base(binary))
	content, err := os.ReadFile(binary)
	must(t, err)
	must(t, os.WriteFile(other, content, 0o755))
	for _, mode := range []string{"desktop", "headless"} {
		for _, failure := range []string{"different-installation", "legacy-dead-owner", "corrupt-owner"} {
			t.Run(mode+"/"+failure, func(t *testing.T) {
				state := stateDirectoryForCLI(t)
				catalogRoot := filepath.Join(t.TempDir(), "dsh-launcher")
				must(t, os.Mkdir(catalogRoot, 0o700))
				store, err := catalog.Open(catalogRoot)
				must(t, err)
				originalCatalog, err := store.Enable()
				must(t, err)
				remotePath := filepath.Join(catalogRoot, remoteconnections.FileName)
				remotes, err := remoteconnections.Open(remotePath)
				must(t, err)
				originalRemote, err := remotes.Create("Original computer", "original.example", 2222, "original-user", "")
				must(t, err)

				config := runtimeowner.Config{Executable: binary, StateRoot: state, CatalogRoot: catalogRoot}
				owner, err := runtimeowner.Open(context.Background(), config)
				must(t, err)
				identity := owner.Identity()
				ownerPath := filepath.Join(state, "runtime-owner", "owner.json")
				candidate, refusal := binary, "runtime.owner_unavailable"
				switch failure {
				case "different-installation":
					candidate, refusal = other, "runtime.owner_identity_mismatch"
					t.Cleanup(func() {
						ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
						defer cancel()
						must(t, owner.Shutdown(ctx))
					})
				case "legacy-dead-owner":
					raw, err := os.ReadFile(ownerPath)
					must(t, err)
					var endpoint struct {
						Socket    string `json:"socket"`
						Directory string `json:"socketDirectory"`
					}
					must(t, json.Unmarshal(raw, &endpoint))
					if endpoint.Directory != "" {
						t.Cleanup(func() {
							if filepath.Dir(endpoint.Socket) != endpoint.Directory {
								t.Error("owned endpoint directory changed")
								return
							}
							_ = os.Remove(endpoint.Socket)
							_ = os.Remove(endpoint.Directory)
						})
					}
					current, err := runtimeowner.InspectIdentity(config)
					must(t, err)
					if current != identity {
						t.Fatal("owned process identity changed before death injection")
					}
					process, err := os.FindProcess(identity.PID)
					must(t, err)
					must(t, process.Kill())
					_ = process.Release()
					deadline := time.Now().Add(5 * time.Second)
					for {
						_, err := runtimeowner.InspectIdentity(config)
						if errors.Is(err, runtimeowner.ErrOwnerUnavailable) {
							break
						}
						if time.Now().After(deadline) {
							t.Fatal("the exact isolated owner did not exit")
						}
						time.Sleep(time.Millisecond)
					}
					must(t, owner.Close())
					// The previous release had no durable child/boot safety journal.
					// A missing owner PID alone must never authorize its takeover.
					if err := os.Remove(filepath.Join(state, "runtime-owner", "recovery.json")); err != nil && !os.IsNotExist(err) {
						t.Fatal(err)
					}
				case "corrupt-owner":
					ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
					must(t, owner.Shutdown(ctx))
					cancel()
					must(t, os.WriteFile(ownerPath, []byte(`{"invalid":true}`), 0o600))
					refusal = "runtime.owner_record_invalid"
				}
				before, err := os.ReadFile(ownerPath)
				must(t, err)
				core := isolationBootCore(t, candidate, state, catalogRoot, mode)
				ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
				defer cancel()
				assertCoreVersion(t, callCore(t, ctx, core.peer, "core.version", struct{}{}))
				isolationAssertCatalogs(t, ctx, core.peer, originalCatalog, originalRemote, remotePath)
				for method, payload := range map[string]any{
					"runtime.status":  map[string]string{"subjectId": "subject_main"},
					"runtime.stop":    map[string]string{"subjectId": "subject_main"},
					"runtime.console": map[string]int64{"cursor": 0},
					"runtime.start": map[string]any{
						"launchId": "launch_main", "subjectId": "subject_main", "directory": "",
						"profile": "node", "nodeExecutable": "", "pnpmExecutable": "",
						"pnpmPrefixArguments": []string{}, "pnpmResolutionError": "",
						"pnpmCommandSearchPath": "", "diagnosticsPatchPath": "",
						"port": map[string]string{"mode": "auto"}, "logPath": "",
					},
				} {
					if _, err := core.peer.Call(ctx, method, payload); err == nil || err.Error() != refusal {
						t.Fatalf("%s did not retain runtime admission refusal: %v", method, err)
					}
				}
				if _, err := core.peer.Call(ctx, "devices.list", map[string]any{"serviceId": strings.Repeat("a", 64), "data": map[string]any{}}); err == nil || err.Error() != "p2p.service_unconfigured" {
					t.Fatalf("P2P service boundary was disabled by local runtime failure: %v", err)
				}
				if mode == "headless" {
					if _, err := core.peer.Call(ctx, "core.runtime_binding", struct{}{}); err == nil || err.Error() != refusal {
						t.Fatalf("headless binding hid runtime refusal: %v", err)
					}
					command := exec.Command(candidate, "status", "--json", "--state", state)
					isolationHideCommand(command)
					var stdout, stderr bytes.Buffer
					command.Stdout, command.Stderr = &stdout, &stderr
					if err := command.Run(); err != nil {
						t.Fatalf("JSON status failed after runtime refusal: %v", err)
					}
					var status struct {
						LaunchError string `json:"launchError"`
					}
					if json.Unmarshal(stdout.Bytes(), &status) != nil || status.LaunchError != refusal {
						t.Fatal("JSON status hid runtime refusal")
					}
				}
				core.stop(t)
				after, err := os.ReadFile(ownerPath)
				must(t, err)
				if sha256.Sum256(before) != sha256.Sum256(after) {
					t.Fatal("core changed or replaced the refused owner record")
				}
				if failure == "different-installation" {
					current, err := runtimeowner.InspectIdentity(config)
					must(t, err)
					if current != identity {
						t.Fatal("alternate installation stopped or replaced the original authority")
					}
				}
			})
		}
	}
}

func isolationCoreBinary(t *testing.T) string {
	t.Helper()
	name := "dshkerd"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	binary := filepath.Join(t.TempDir(), name)
	command := exec.Command("go", "build", "-buildvcs=false", "-o", binary, corePackage)
	isolationHideCommand(command)
	command.Stderr = os.Stderr
	must(t, command.Run())
	return binary
}

type isolationCore struct {
	peer     *localrpc.Peer
	command  *exec.Cmd
	done     chan error
	headless bool
	stopped  bool
}

func isolationBootCore(t *testing.T, binary, state, catalogRoot, mode string, dataRoots ...string) *isolationCore {
	t.Helper()
	args := []string{"--state", state, "--catalog", catalogRoot}
	if len(dataRoots) == 1 {
		args = append(args, "--data", dataRoots[0])
	} else if len(dataRoots) != 0 {
		t.Fatal("isolated core requires exactly one explicit data root")
	}
	headless := mode == "headless"
	if headless {
		args = append([]string{"serve"}, args...)
	}
	command := exec.Command(binary, args...)
	isolationHideCommand(command)
	command.Stderr = os.Stderr
	stdin, err := command.StdinPipe()
	must(t, err)
	stdout, err := command.StdoutPipe()
	must(t, err)
	must(t, command.Start())
	active := &isolationCore{command: command, done: make(chan error, 1), headless: headless}
	go func() { active.done <- command.Wait() }()
	t.Cleanup(func() { active.stop(t) })
	endpoint, secret := coreEndpoint(t), strings.Repeat("d", 64)
	if !headless {
		record, err := json.Marshal(localrpc.Bootstrap{Version: 1, Socket: endpoint, Secret: secret})
		must(t, err)
		_, err = stdin.Write(append(record, '\n'))
		must(t, err)
	}
	must(t, stdin.Close())
	line, err := bufio.NewReader(stdout).ReadString('\n')
	must(t, err)
	if headless {
		var ready struct {
			Version int    `json:"version"`
			Serving bool   `json:"serving"`
			Socket  string `json:"socket"`
		}
		if json.Unmarshal([]byte(line), &ready) != nil || ready.Version != 1 || !ready.Serving || ready.Socket == "" {
			t.Fatal("headless core did not become ready after runtime refusal")
		}
		record, err := localrpc.ReadEndpointRecord(filepath.Join(state, localrpc.EndpointFileName))
		must(t, err)
		endpoint, secret = record.Socket, record.Secret
	} else if line != coreReadiness {
		t.Fatal("desktop core did not announce readiness")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	connection, err := localrpc.Connect(ctx, endpoint, secret)
	must(t, err)
	active.peer = localrpc.New(context.Background(), connection, func(context.Context, string, json.RawMessage) (any, error) {
		return nil, errors.New("p2p.unexpected_callback")
	})
	return active
}

func (active *isolationCore) stop(t *testing.T) {
	t.Helper()
	if active.stopped {
		return
	}
	active.stopped = true
	if active.peer != nil {
		active.peer.Close()
	}
	if active.headless && runtime.GOOS != "windows" {
		_ = active.command.Process.Signal(os.Interrupt)
	}
	if active.headless && runtime.GOOS == "windows" {
		_ = active.command.Process.Kill()
	}
	select {
	case err := <-active.done:
		if !active.headless && err != nil {
			t.Errorf("desktop core failed normal refused-owner shutdown: %v", err)
		}
	case <-time.After(8 * time.Second):
		_ = active.command.Process.Kill()
		<-active.done
		t.Error("isolated core failed to exit")
	}
}

func isolationAssertCatalogs(t *testing.T, ctx context.Context, peer *localrpc.Peer, original catalog.Snapshot, computers []remoteconnections.Computer, remotePath string) {
	t.Helper()
	raw := callCore(t, ctx, peer, "core.catalog_inspect", struct{}{})
	var catalogReply struct {
		Enabled  bool           `json:"enabled"`
		Revision string         `json:"revision"`
		Record   catalog.Record `json:"record"`
	}
	must(t, json.Unmarshal(raw, &catalogReply))
	if !catalogReply.Enabled || catalogReply.Record.CatalogID != original.Record.CatalogID || catalogReply.Revision != original.Revision {
		t.Fatal("runtime refusal changed or hid the existing P2P catalog")
	}
	raw = callCore(t, ctx, peer, "remote.catalog_inspect", map[string]string{"filePath": remotePath})
	var remoteReply struct {
		Connections []remoteconnections.Computer `json:"connections"`
	}
	must(t, json.Unmarshal(raw, &remoteReply))
	if len(remoteReply.Connections) != 1 || remoteReply.Connections[0] != computers[0] {
		t.Fatal("runtime refusal changed or hid the original SSH computer")
	}
	callCore(t, ctx, peer, "remote.catalog_create", map[string]any{"filePath": remotePath, "displayName": "Second computer", "host": "second.example", "port": 22, "user": "second-user", "sshKeyPath": ""})
	raw = callCore(t, ctx, peer, "remote.catalog_inspect", map[string]string{"filePath": remotePath})
	must(t, json.Unmarshal(raw, &remoteReply))
	if len(remoteReply.Connections) != 2 || remoteReply.Connections[0] != computers[0] || remoteReply.Connections[1].Host != "second.example" {
		t.Fatal("SSH catalog write/read-back failed while runtime owner was refused")
	}
	stored, err := os.ReadFile(remotePath)
	must(t, err)
	var persisted remoteconnections.Record
	must(t, json.Unmarshal(stored, &persisted))
	if len(persisted.Connections) != 2 || persisted.Connections[0] != computers[0] {
		t.Fatal("SSH read-back did not match the durable original computer")
	}
	// A second catalog read proves that unrelated SSH writes do not change its
	// ownership identity or byte revision.
	raw = callCore(t, ctx, peer, "core.catalog_inspect", struct{}{})
	var readback struct {
		Revision string `json:"revision"`
	}
	must(t, json.Unmarshal(raw, &readback))
	if readback.Revision != original.Revision || !bytes.Contains(raw, []byte(original.Record.CatalogID)) {
		t.Fatal("SSH writes changed P2P catalog identity")
	}
}
