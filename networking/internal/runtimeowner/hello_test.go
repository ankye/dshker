package runtimeowner

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/localrpc"
)

func TestOwnerHelloRefusesAuthenticatedWrongIdentity(t *testing.T) {
	for _, name := range []string{"epoch", "protocol", "config", "authentication"} {
		t.Run(name, func(t *testing.T) {
			config := ownerTestConfig(t)
			_, record := pendingRecord(t, config)
			var err error
			record.Process, err = processIdentityAt(os.Getpid())
			if err != nil {
				t.Fatal(err)
			}
			answer := record
			wanted := ErrOwnerIdentityMismatch
			switch name {
			case "epoch":
				answer.Instance = strings.Repeat("b", 32)
			case "protocol":
				answer.Version++
				wanted = ErrOwnerProtocol
			case "config":
				answer.Config.DataRoot = answer.Config.StateRoot
			case "authentication":
				wanted = ErrOwnerUnavailable
			}
			listener, err := localrpc.Listen(record.Socket)
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			server := &ownerServer{local: NewLocal(), record: answer, stop: cancel}
			served := make(chan error, 1)
			authenticationToken := record.Token
			go func() {
				served <- localrpc.ServeEndpointWithPeers(ctx, listener, authenticationToken, server.handlerFor, server.disconnected)
			}()
			t.Cleanup(func() {
				cancel()
				listener.Close()
				select {
				case <-served:
				case <-time.After(5 * time.Second):
					t.Error("private hello server failed to join")
				}
			})
			if name == "authentication" {
				record.Token = strings.Repeat("a", 64)
			}
			client, err := connectOwner(ctx, record)
			if client != nil {
				client.Close()
			}
			if !errors.Is(err, wanted) {
				t.Fatalf("private authenticated hello %s failed open or changed refusal: %v", name, err)
			}
			if _, present, err := server.local.Status(context.Background(), "subject_absent"); err != nil || present {
				t.Fatal("refused owner hello started or fabricated a runtime")
			}
		})
	}
}
