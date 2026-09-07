package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"

	"github.com/ankye/dshker/networking/internal/helper"
	"github.com/ankye/dshker/networking/internal/localrpc"
)

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--version" {
		fmt.Println("dshker-peer/1")
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
	host := helper.New(ctx)
	bound := make(chan struct{})
	rpc := localrpc.New(ctx, conn, func(callCtx context.Context, method string, data json.RawMessage) (any, error) {
		select {
		case <-bound:
			return host.Handle(callCtx, method, data)
		case <-callCtx.Done():
			return nil, callCtx.Err()
		}
	})
	host.BindMain(rpc)
	close(bound)
	<-rpc.Done()
	cancel()
	host.Close()
	rpc.Close()
	return nil
}
