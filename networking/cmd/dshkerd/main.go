package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"

	"github.com/ankye/dshker/networking/internal/catalog"
	"github.com/ankye/dshker/networking/internal/core"
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
}

// parseArguments accepts --data <absolute directory> and --catalog <absolute
// directory>, in any order, each at most once.
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
		default:
			return options{}, errors.New("p2p.invalid_arguments")
		}
	}
	return parsed, nil
}

func run(parsed options) error {
	server := core.Serve{}
	if parsed.dataRoot != "" {
		store, err := secret.Open(parsed.dataRoot)
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
	rpc := localrpc.New(ctx, conn, server.Handle)
	<-rpc.Done()
	cancel()
	rpc.Close()
	return nil
}
