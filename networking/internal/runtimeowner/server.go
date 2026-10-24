package runtimeowner

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/ankye/dshker/networking/internal/localrpc"
	"github.com/ankye/dshker/networking/internal/protocol"
)

type ownerServer struct {
	local     *Local
	record    ownerRecord
	stop      context.CancelFunc
	mu        sync.Mutex
	shutdowns map[*localrpc.Peer]*shutdownAttempt
}

type shutdownAttempt struct {
	pending          int
	disconnected     bool
	succeeded        bool
	containedFailure bool
}

// Run is the private same-binary mode. It owns no account/secret store and has
// no dependency on the requesting core's connection or process lifetime.
func Run(ctx context.Context, config Config) error {
	expected, err := configRecord(config)
	if err != nil {
		return err
	}
	config = expected.Config
	self, err := os.Executable()
	if err != nil {
		return ErrOwnerIdentityMismatch
	}
	self, err = filepath.EvalSymlinks(self)
	if err != nil || self != config.Executable {
		return ErrOwnerIdentityMismatch
	}
	directory := filepath.Join(config.StateRoot, ownerDirectory)
	if err := checkPrivatePath(directory, true); err != nil {
		return ErrOwnerRecordInvalid
	}
	lease, err := localrpc.AcquireOwnerLock(ctx, directory, false)
	if err != nil {
		return ErrOwnerUnavailable
	}
	defer lease.Release()
	path := filepath.Join(directory, recordFileName)
	record, err := readRecord(path)
	if err != nil {
		return err
	}
	if !sameConfiguration(record, expected) {
		return ErrOwnerIdentityMismatch
	}
	if err := validateOwnerEndpoint(record); err != nil {
		return err
	}
	if record.Process.PID != 0 { // A dead owner is never silently replaced.
		return ErrOwnerUnavailable
	}
	if record.Process, err = processIdentityAt(os.Getpid()); err != nil {
		return err
	}
	containment, err := newProcessContainment(record)
	if err != nil {
		return err
	}
	clean := false
	defer func() { containment.close(clean) }()
	listener, err := localrpc.Listen(record.Socket)
	if err != nil {
		return ErrOwnerUnavailable
	}
	defer listener.Close()
	if err := writeRecord(path, record); err != nil {
		return err
	}
	lifetime, stop := context.WithCancel(ctx)
	defer stop()
	local := NewLocal()
	local.containment = containment
	local.recovery, err = newActivityJournal(directory, record)
	if err != nil {
		return err
	}
	server := &ownerServer{local: local, record: record, stop: stop}
	go func() { <-lifetime.Done(); listener.Close() }()
	serveErr := localrpc.ServeEndpointWithPeers(lifetime, listener, record.Token, server.handlerFor, server.disconnected)
	cleanup, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := local.Shutdown(cleanup); err != nil {
		return err // Retain the record; do not claim an unjoined child disappeared.
	}
	listener.Close()
	if err := cleanupOwnerEndpoint(record); err != nil {
		return err
	}
	if err := removeOwnedRecord(path, record); err != nil {
		return err
	}
	if err := removeRecoveryJournal(filepath.Join(directory, recoveryFileName), local.recovery.value); err != nil {
		return err
	}
	clean = true
	return serveErr
}

func (server *ownerServer) handlerFor(peer *localrpc.Peer) localrpc.Handler {
	return func(ctx context.Context, method string, raw json.RawMessage) (any, error) {
		switch method {
		case "owner.hello":
			var request struct{}
			if err := protocol.DecodeExact(raw, &request); err != nil {
				return nil, err
			}
			return helloFor(server.record), nil
		case "owner.start":
			var request startRequest
			if err := protocol.DecodeExact(raw, &request); err != nil {
				return nil, err
			}
			view, err := server.local.Start(ctx, request.launch())
			return launchResult{encodeLaunch(view)}, err
		case "owner.stop", "owner.status", "owner.binding":
			var request subjectRequest
			if err := protocol.DecodeExact(raw, &request); err != nil {
				return nil, err
			}
			if request.Subject == "" {
				return nil, ErrOwnerConfiguration
			}
			if method == "owner.binding" {
				return server.local.Binding(ctx, request.Subject)
			}
			if method == "owner.stop" {
				view, err := server.local.Stop(ctx, request.Subject)
				return launchResult{encodeLaunch(view)}, err
			}
			view, present, err := server.local.Status(ctx, request.Subject)
			encoded := json.RawMessage(`{}`)
			if present {
				encoded = encodeLaunch(view)
			}
			return statusResult{present, encoded}, err
		case "owner.console":
			var request consoleRequest
			if err := protocol.DecodeExact(raw, &request); err != nil {
				return nil, err
			}
			if request.Cursor < 0 {
				return nil, ErrOwnerConfiguration
			}
			entries, cursor, err := server.local.Console(ctx, request.Cursor)
			return consoleResult{entries, cursor}, err
		case "owner.shutdown":
			var request struct{}
			if err := protocol.DecodeExact(raw, &request); err != nil {
				return nil, err
			}
			attempt := server.shutdownStarted(peer)
			if err := server.local.Shutdown(ctx); err != nil {
				if server.local.containment != nil && server.local.containment.containedExit() {
					server.mu.Lock()
					attempt.containedFailure = true
					server.mu.Unlock()
				}
				server.shutdownFinished(peer, attempt, false)
				return nil, err
			}
			server.shutdownFinished(peer, attempt, true)
			return shutdownResult{true}, nil
		default:
			return nil, ErrOwnerProtocol
		}
	}
}

func (server *ownerServer) disconnected(peer *localrpc.Peer) {
	server.mu.Lock()
	attempt := server.shutdowns[peer]
	closing := false
	if attempt != nil {
		attempt.disconnected = true
		closing = attempt.succeeded || attempt.containedFailure
	}
	server.mu.Unlock()
	if closing {
		server.stop()
	}
}

func (server *ownerServer) shutdownStarted(peer *localrpc.Peer) *shutdownAttempt {
	server.mu.Lock()
	defer server.mu.Unlock()
	if server.shutdowns == nil {
		server.shutdowns = make(map[*localrpc.Peer]*shutdownAttempt)
	}
	attempt := server.shutdowns[peer]
	if attempt == nil {
		attempt = &shutdownAttempt{}
		server.shutdowns[peer] = attempt
	}
	attempt.pending++
	// EOF can precede even the handler's first instruction. Done is durable;
	// disconnected callbacks alone are an edge that could already be lost.
	select {
	case <-peer.Done():
		attempt.disconnected = true
	default:
	}
	return attempt
}

func (server *ownerServer) shutdownFinished(peer *localrpc.Peer, attempt *shutdownAttempt, success bool) {
	server.mu.Lock()
	attempt.pending--
	attempt.succeeded = attempt.succeeded || success
	closing := (attempt.succeeded || attempt.containedFailure) && attempt.disconnected
	if attempt.pending == 0 && !attempt.succeeded && !attempt.containedFailure {
		delete(server.shutdowns, peer)
	}
	server.mu.Unlock()
	if closing {
		server.stop()
	}
}
