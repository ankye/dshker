package runtimeowner

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/localrpc"
)

func TestConcurrentFirstOpenCreatesExactlyOneEmptyOwner(t *testing.T) {
	config := ownerTestConfig(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	const count = 6
	type outcome struct {
		client *Client
		err    error
	}
	start := make(chan struct{})
	results := make(chan outcome, count)
	for range count {
		go func() {
			<-start
			client, err := Open(ctx, config)
			results <- outcome{client, err}
		}()
	}
	close(start)
	clients := make([]*Client, 0, count)
	for range count {
		result := <-results
		if result.err != nil {
			t.Errorf("concurrent initial Open refused its serialized first owner: %v", result.err)
		} else {
			clients = append(clients, result.client)
		}
	}
	if len(clients) == 0 {
		t.Fatal("concurrent initial Open created no owner")
	}
	stopped := false
	t.Cleanup(func() {
		if !stopped {
			shutdownOwner(t, clients[0])
		}
		for _, client := range clients {
			client.Close()
		}
	})
	created := 0
	identity := clients[0].Identity()
	for _, client := range clients {
		if client.Created() {
			created++
		}
		if client.Identity() != identity {
			t.Fatal("concurrent initial Open created a second owner instance or process")
		}
		if _, present, err := client.Status(ctx, "never_started"); err != nil || present {
			t.Fatal("initial Open registered a child without an explicit Start")
		}
		if _, err := client.Binding(ctx, "never_started"); !errors.Is(err, ErrRuntimeUnavailable) {
			t.Fatalf("empty owner supplied a runtime binding without Start: %v", err)
		}
		entries, cursor, err := client.Console(ctx, 0)
		if err != nil || len(entries) != 0 || cursor != 0 {
			t.Fatal("initial Open produced child console output without an explicit Start")
		}
	}
	if created != 1 || len(clients) != count {
		t.Fatalf("six initial Open calls must admit one creator and five attachments: created=%d attached=%d", created, len(clients))
	}
	recordPath := filepath.Join(identity.Config.StateRoot, ownerDirectory, recordFileName)
	record, err := readRecord(recordPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := clients[0].Shutdown(ctx); err != nil {
		t.Fatalf("concurrent owner shutdown did not join its process and release its lease: %v", err)
	}
	stopped = true
	if _, err := os.Lstat(recordPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("shutdown retained the exact owner identity record")
	}
	if record.SocketDirectory != "" {
		if _, err := os.Lstat(record.SocketDirectory); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("shutdown retained the exact private endpoint directory")
		}
	}
	probe, stopProbe := context.WithTimeout(ctx, time.Second)
	defer stopProbe()
	if connection, err := localrpc.Connect(probe, record.Socket, record.Token); err == nil {
		connection.Close()
		t.Fatal("shutdown left its authenticated endpoint accepting connections")
	}
}
