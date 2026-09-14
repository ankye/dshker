package remoteroute

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestRouteOwnsOneGenerationPerConnection(t *testing.T) {
	connector, tunnels, _ := newGeneration(t, nil)
	route := &Route{Connector: *connector}
	ctx := context.Background()
	url, err := route.Connect(ctx, "connection_main", computer(), nil)
	if err != nil || url == "" {
		t.Fatalf("connect = %q, %v", url, err)
	}
	if live, ok := route.URL("connection_main"); !ok || live != url {
		t.Fatalf("url = %q, %v", live, ok)
	}
	// The same id cannot be opened twice.
	if _, err := route.Connect(ctx, "connection_main", computer(), nil); !errors.Is(err, ErrConnectionBusy) {
		t.Fatalf("second connect = %v", err)
	}
	if err := route.Disconnect("connection_main"); err != nil {
		t.Fatalf("disconnect: %v", err)
	}
	if _, ok := route.URL("connection_main"); ok {
		t.Fatal("a disconnected generation reported a url")
	}
	if err := route.Disconnect("connection_main"); !errors.Is(err, ErrNotConnected) {
		t.Fatalf("second disconnect = %v", err)
	}
	for _, tunnel := range *tunnels {
		if tunnel.stopCount() == 0 {
			t.Fatal("a forward was left running")
		}
	}
}

func TestRouteRefusesAConnectWithoutAnId(t *testing.T) {
	connector, _, _ := newGeneration(t, nil)
	route := &Route{Connector: *connector}
	if _, err := route.Connect(context.Background(), "", computer(), nil); !errors.Is(err, ErrInputInvalid) {
		t.Fatalf("no id = %v", err)
	}
}

// TestRouteShutdownStopsEveryGeneration covers the core's own exit path.
func TestRouteShutdownStopsEveryGeneration(t *testing.T) {
	// Two connections need two generations, so the port reserve must keep
	// answering; the seam is replaced before the route copies the connector.
	ports := []int{51000, 52000, 53000, 54000}
	index := 0
	connector, tunnels, _ := newGeneration(t, func(connector *Connector) {
		connector.ReservePort = func() (int, error) {
			port := ports[index]
			index++
			return port, nil
		}
	})
	route := &Route{Connector: *connector}
	for _, id := range []string{"connection_one", "connection_two"} {
		if _, err := route.Connect(context.Background(), id, computer(), nil); err != nil {
			t.Fatalf("connect %s: %v", id, err)
		}
	}
	route.Shutdown()
	for _, tunnel := range *tunnels {
		if tunnel.stopCount() == 0 {
			t.Fatal("shutdown left a forward running")
		}
	}
}

// TestRouteRetiresADeadGeneration proves an unexpected forward exit frees the id
// and tells the caller, so the next connect is not refused by a corpse.
func TestRouteRetiresADeadGeneration(t *testing.T) {
	connector, tunnels, _ := newGeneration(t, nil)
	route := &Route{Connector: *connector}
	retired := make(chan struct{}, 1)
	if _, err := route.Connect(context.Background(), "connection_main", computer(), func() {
		retired <- struct{}{}
	}); err != nil {
		t.Fatalf("connect: %v", err)
	}
	close((*tunnels)[1].exited)
	select {
	case <-retired:
	case <-time.After(5 * time.Second):
		t.Fatal("a dead forward did not report itself")
	}
	if _, ok := route.URL("connection_main"); ok {
		t.Fatal("a dead generation still reported a url")
	}
}
