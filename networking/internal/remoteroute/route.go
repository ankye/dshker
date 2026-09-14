package remoteroute

import (
	"context"
	"errors"
	"fmt"
	"sync"
)

// ErrNotConnected is the refusal a disconnect for an unknown generation gets. It
// reports the shell's own "no such remote connection" code: the renderer maps
// every declared remote code to a message, and a new code would mean a renderer
// change for a failure the page never shows.
var ErrNotConnected = errors.New("remote.connection_not_found")

// Route owns every live SSH generation the core started. It is the process
// authority the shell used to hold, so a connection now survives a renderer
// reload and dies with the core.
type Route struct {
	// Connector is the operation set one generation needs. A zero value uses the
	// production OpenSSH implementations.
	Connector Connector

	mutex       sync.Mutex
	generations map[string]generation
}

type generation struct {
	url  string
	stop func()
}

// NewRoute builds the production route.
func NewRoute() *Route { return &Route{generations: map[string]generation{}} }

// Connect starts one generation and returns the local URL that carries it. A
// second connect for the same id is refused: the id names one connection.
func (route *Route) Connect(ctx context.Context, connectionID string, computer Computer, onUnexpectedExit func()) (string, error) {
	return route.ConnectWith(ctx, connectionID, computer, route.Connector, onUnexpectedExit)
}

// ConnectWith starts one generation with an explicit connector, while the route
// still owns the generation record. It is how a caller that names its own
// OpenSSH clients — a host with a non-standard installation, or a test — uses the
// same ownership.
func (route *Route) ConnectWith(ctx context.Context, connectionID string, computer Computer, connector Connector, onUnexpectedExit func()) (string, error) {
	if connectionID == "" {
		return "", fmt.Errorf("%w: the connection id is required.", ErrInputInvalid)
	}
	route.mutex.Lock()
	if _, live := route.generations[connectionID]; live {
		route.mutex.Unlock()
		return "", fmt.Errorf("%w: the remote connection is already open.", ErrConnectionBusy)
	}
	route.mutex.Unlock()
	url, stop, err := connector.Connect(ctx, computer, func() {
		route.retire(connectionID)
		if onUnexpectedExit != nil {
			onUnexpectedExit()
		}
	})
	if err != nil {
		return "", err
	}
	route.mutex.Lock()
	if route.generations == nil {
		route.generations = map[string]generation{}
	}
	route.generations[connectionID] = generation{url: url, stop: stop}
	route.mutex.Unlock()
	return url, nil
}

// Disconnect stops one generation and reports whether it existed.
func (route *Route) Disconnect(connectionID string) error {
	route.mutex.Lock()
	active, live := route.generations[connectionID]
	delete(route.generations, connectionID)
	route.mutex.Unlock()
	if !live {
		return fmt.Errorf("%w: no remote connection is open for that id.", ErrNotConnected)
	}
	active.stop()
	return nil
}

// URL reports the address one live generation carries.
func (route *Route) URL(connectionID string) (string, bool) {
	route.mutex.Lock()
	defer route.mutex.Unlock()
	active, live := route.generations[connectionID]
	if !live {
		return "", false
	}
	return active.url, true
}

// Shutdown stops every generation. It runs when the core is asked to exit.
func (route *Route) Shutdown() {
	route.mutex.Lock()
	ids := make([]string, 0, len(route.generations))
	for id := range route.generations {
		ids = append(ids, id)
	}
	route.mutex.Unlock()
	for _, id := range ids {
		_ = route.Disconnect(id)
	}
}

// retire forgets one generation a forward already ended, so the next connect for
// the same id is allowed instead of being refused by a corpse.
func (route *Route) retire(connectionID string) {
	route.mutex.Lock()
	defer route.mutex.Unlock()
	delete(route.generations, connectionID)
}
