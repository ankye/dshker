package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"

	"github.com/ankye/dshker/networking/internal/core"
	"github.com/ankye/dshker/networking/internal/localrpc"
)

// dshkerd is the headless core. With no arguments it acquires the one-shot
// bootstrap from its parent, serves the private per-user endpoint, and answers
// the versioned method table until the parent goes away.
func main() {
	if len(os.Args) == 2 && os.Args[1] == "--version" {
		fmt.Println("dshkerd/1")
		return
	}
	if len(os.Args) != 1 {
		fmt.Fprintln(os.Stderr, "p2p.invalid_arguments")
		os.Exit(1)
	}
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "p2p.helper_failed")
		os.Exit(1)
	}
}

func run() error {
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
