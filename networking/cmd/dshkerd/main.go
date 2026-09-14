package main

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"

	"github.com/ankye/dshker/networking/internal/catalog"
	"github.com/ankye/dshker/networking/internal/core"
	"github.com/ankye/dshker/networking/internal/harnessruntime"
	"github.com/ankye/dshker/networking/internal/helper"
	"github.com/ankye/dshker/networking/internal/localrpc"
	"github.com/ankye/dshker/networking/internal/secret"
)

// dshkerd is the headless core. It acquires the one-shot bootstrap from its
// parent, serves the private per-user endpoint, and answers the versioned
// method table until the parent goes away. An optional --data argument names
// the main-owned directory the core persists under (the platform secret store
// is rooted there), and an optional --catalog argument names the directory
// holding the device catalog. Both are opened at boot, so a bad root fails
// before any RPC starts rather than on the first call that needs it.
//
// The core answers the whole published table: its own core.* methods against its
// stores, and the coordinator, pairing, enrollment and runtime operations
// through the same peer host the peer executable runs. That is what lets the
// shell stop launching a second child; until it does, a core with no configured
// service simply holds an idle host.
func main() {
	if len(os.Args) == 2 && os.Args[1] == "--version" {
		fmt.Println("dshkerd/1")
		return
	}
	parsed, err := parseArguments(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err := run(parsed); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// options is the parsed command line. Both roots are optional and, when given,
// must be absolute directories the parent owns; every other spelling is a typed
// refusal so a typo cannot silently start a core with the wrong state.
type options struct {
	dataRoot    string
	catalogRoot string
	rootsPath   string
}

// parseArguments accepts --data <absolute directory>, --catalog <absolute
// directory> and --roots <absolute PEM file>, in any order, each at most once.
func parseArguments(args []string) (options, error) {
	var parsed options
	for index := 0; index < len(args); index += 2 {
		if index+1 >= len(args) {
			return options{}, errors.New("p2p.invalid_arguments")
		}
		value := args[index+1]
		if value == "" || !filepath.IsAbs(value) {
			return options{}, errors.New("p2p.invalid_arguments")
		}
		switch args[index] {
		case "--data":
			if parsed.dataRoot != "" {
				return options{}, errors.New("p2p.invalid_arguments")
			}
			parsed.dataRoot = value
		case "--catalog":
			if parsed.catalogRoot != "" {
				return options{}, errors.New("p2p.invalid_arguments")
			}
			parsed.catalogRoot = value
		case "--roots":
			if parsed.rootsPath != "" {
				return options{}, errors.New("p2p.invalid_arguments")
			}
			parsed.rootsPath = value
		default:
			return options{}, errors.New("p2p.invalid_arguments")
		}
	}
	return parsed, nil
}

// loadRoots reads one PEM bundle of CA certificates and returns the machine's
// store with those anchors added, so naming a private CA never removes the
// public ones. An unreadable bundle, or one holding no certificate at all, is
// refused rather than silently falling back to the store alone: the caller asked
// for these anchors specifically.
func loadRoots(path string) (*x509.CertPool, error) {
	pem, err := os.ReadFile(path)
	if err != nil {
		return nil, errors.New("p2p.invalid_arguments")
	}
	roots, err := x509.SystemCertPool()
	if err != nil || roots == nil {
		// A store that cannot be read is not a reason to refuse the anchors the
		// caller did name; they are still verified against.
		roots = x509.NewCertPool()
	}
	if !roots.AppendCertsFromPEM(pem) {
		return nil, errors.New("p2p.invalid_arguments")
	}
	return roots, nil
}

// secretStoreFor reports the store the core serves with.
//
// A host with no platform provider — a Linux container without a keyring, say —
// still runs a core: a nil store is a legitimate configuration, and every secret
// method refuses per call with p2p.secret_provider_unavailable so a shell never
// mistakes "no provider" for an empty store. Refusing the boot instead would take
// the device catalog and the managed roots down with the keyring, which is a
// much larger failure than the one being reported. Every other failure is still
// fatal, because it means the store exists and is broken.
func secretStoreFor(open func(string) (secret.Store, error), dataRoot string) (secret.Store, error) {
	store, err := open(dataRoot)
	if errors.Is(err, secret.ErrUnavailable) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return store, nil
}

func run(parsed options) error {
	server := core.Serve{}
	if parsed.dataRoot != "" {
		store, err := secretStoreFor(secret.Open, parsed.dataRoot)
		if err != nil {
			return err
		}
		server.Store = store
	}
	// The catalog directory must already exist: it is the shell's settings root,
	// which the shell creates and already relies on for the credential store. A
	// missing directory is a caller bug, not an empty catalog.
	if parsed.catalogRoot != "" {
		store, err := catalog.Open(parsed.catalogRoot)
		if err != nil {
			return err
		}
		server.Catalog = store
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()
	conn, err := localrpc.AcceptMain(ctx, os.Stdin, os.Stdout)
	if err != nil {
		return err
	}
	host := helper.New(ctx)
	// Explicit trust anchors for the coordinator, added to the machine's store.
	// The shell passes none, so the app keeps refusing a server this machine does
	// not already trust; a headless host that must reach a coordinator with a
	// private CA names it here instead of modifying the OS trust store.
	if parsed.rootsPath != "" {
		roots, err := loadRoots(parsed.rootsPath)
		if err != nil {
			return err
		}
		host.SetRoots(roots)
	}
	// The DSH Web child belongs to the core now. The supervisor is created once
	// per process so a launch survives a renderer reload, and the deferred
	// shutdown means no child outlives the channel that started it: a crashed
	// shell closes this connection, which ends the daemon and stops the tree.
	runtimeSupervisor := harnessruntime.NewSupervisor()
	defer runtimeSupervisor.Shutdown()
	server.Runtime = runtimeSupervisor
	server.Peer = host
	// The host must be bound before any request is answered: device.restore
	// installs the callback the host uses to ask the shell for a runtime owner
	// and to report connection state. The gate mirrors cmd/dshker-peer.
	bound := make(chan struct{})
	rpc := localrpc.New(ctx, conn, func(callCtx context.Context, method string, payload json.RawMessage) (any, error) {
		select {
		case <-bound:
			return server.Handle(callCtx, method, payload)
		case <-callCtx.Done():
			return nil, callCtx.Err()
		}
	})
	host.BindMain(rpc)
	close(bound)
	<-rpc.Done()
	cancel()
	rpc.Close()
	host.Close()
	return nil
}
