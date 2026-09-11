package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"

	"github.com/ankye/dshker/networking/internal/core"
	"github.com/ankye/dshker/networking/internal/localrpc"
	"github.com/ankye/dshker/networking/internal/secret"
)

// dshkerd is the headless core. It acquires the one-shot bootstrap from its
// parent, serves the private per-user endpoint, and answers the versioned
// method table until the parent goes away. An optional --data argument names
// the main-owned directory the core persists under; the platform secret store
// rooted there is opened at boot, so a bad root fails before any RPC starts.
func main() {
	if len(os.Args) == 2 && os.Args[1] == "--version" {
		fmt.Println("dshkerd/1")
		return
	}
	dataRoot, err := parseArguments(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err := run(dataRoot); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// parseArguments accepts at most one explicit --data <absolute directory>;
// every other spelling is a typed refusal.
func parseArguments(args []string) (string, error) {
	if len(args) == 0 {
		return "", nil
	}
	if len(args) == 2 && args[0] == "--data" && args[1] != "" && filepath.IsAbs(args[1]) {
		return args[1], nil
	}
	return "", errors.New("p2p.invalid_arguments")
}

func run(dataRoot string) error {
	if dataRoot != "" {
		if _, err := secret.Open(dataRoot); err != nil {
			return err
		}
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()
	conn, err := localrpc.AcceptMain(ctx, os.Stdin, os.Stdout)
	if err != nil {
		return err
	}
	rpc := localrpc.New(ctx, conn, core.Handle)
	<-rpc.Done()
	cancel()
	rpc.Close()
	return nil
}
