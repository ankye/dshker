package runtimeowner

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/ankye/dshker/networking/internal/harnessruntime"
	"github.com/ankye/dshker/networking/internal/localrpc"
	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/ankye/dshker/networking/internal/runtimebridge"
)

const startupTimeout = 15 * time.Second

type Client struct {
	peer    *localrpc.Peer
	record  ownerRecord
	created bool
	close   sync.Once
}

// Open creates an empty owner or reconnects to the exact existing one. Proven
// dead, quiescent ownership is archived under both leases before replacement;
// corrupt, incompatible, active or unconfirmed ownership is never replaced.
func Open(ctx context.Context, config Config) (*Client, error) {
	expected, err := configRecord(config)
	if err != nil {
		return nil, err
	}
	config = expected.Config
	startup, cancel := context.WithTimeout(ctx, startupTimeout)
	defer cancel()
	directory := filepath.Join(config.StateRoot, ownerDirectory)
	if err := privateDirectory(directory); err != nil {
		return nil, err
	}
	// This short-lived creation lease is distinct from Run's lifetime lease.
	creation := filepath.Join(directory, "creation")
	if err := privateDirectory(creation); err != nil {
		return nil, err
	}
	lease, err := localrpc.AcquireOwnerLock(startup, creation, true)
	if err != nil {
		return nil, ErrOwnerUnavailable
	}
	defer lease.Release()
	path := filepath.Join(directory, recordFileName)
	record, err := readRecord(path)
	created := false
	if err == nil {
		if !sameConfiguration(record, expected) {
			return nil, ErrOwnerIdentityMismatch
		}
		if record.Process.PID > 0 {
			recovered, recoveryErr := recoverExitedOwner(startup, directory, expected, record)
			if recoveryErr != nil {
				return nil, recoveryErr
			}
			if recovered {
				err = os.ErrNotExist
			}
		}
	}
	if errors.Is(err, os.ErrNotExist) {
		if err := recoverOrphanJournal(startup, directory, expected); err != nil {
			return nil, err
		}
		record, err = createPendingOwner(startup, directory, expected)
		if err != nil {
			return nil, err
		}
		// The pending record precedes spawn: a creator crash cannot let the next
		// core silently launch a second authority in the startup window.
		if err := spawnOwner(config, directory); err != nil {
			return nil, err
		}
		created = true
	} else if err != nil {
		return nil, err
	}
	if !sameConfiguration(record, expected) {
		return nil, ErrOwnerIdentityMismatch
	}
	if err := validateOwnerEndpoint(record); err != nil {
		return nil, err
	}
	for record.Process.PID == 0 {
		select {
		case <-startup.Done():
			return nil, ErrOwnerUnavailable
		case <-time.After(10 * time.Millisecond):
		}
		current, err := readRecord(path)
		if err != nil {
			return nil, err
		}
		if current.Instance != record.Instance || current.Token != record.Token || !sameConfiguration(current, expected) {
			return nil, ErrOwnerIdentityMismatch
		}
		record = current
	}
	client, err := connectOwner(startup, record)
	if err != nil {
		return nil, err
	}
	client.created = created
	return client, nil
}

func spawnOwner(config Config, directory string) error {
	arguments := []string{"--runtime-owner", "--state", config.StateRoot}
	for _, item := range []struct{ name, value string }{{"--data", config.DataRoot}, {"--catalog", config.CatalogRoot}, {"--roots", config.RootsPath}} {
		if item.value != "" {
			arguments = append(arguments, item.name, item.value)
		}
	}
	logPath := filepath.Join(directory, "owner.log")
	if _, err := os.Lstat(logPath); err == nil {
		if err := checkPrivatePath(logPath, false); err != nil {
			return err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return ErrOwnerRecordInvalid
	}
	log, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return ErrOwnerUnavailable
	}
	defer log.Close()
	if err := secureCreatedPath(logPath, false); err != nil {
		return err
	}
	command := exec.Command(config.Executable, arguments...)
	command.Stdout, command.Stderr = log, log
	command.SysProcAttr = detachedAttributes()
	if command.Start() != nil {
		return ErrOwnerUnavailable
	}
	go func() { _ = command.Wait() }()
	return nil
}

func connectOwner(ctx context.Context, record ownerRecord) (*Client, error) {
	identity, err := processIdentityAt(record.Process.PID)
	if err != nil || identity != record.Process {
		return nil, ErrOwnerUnavailable
	}
	connection, err := localrpc.Connect(ctx, record.Socket, record.Token)
	if err != nil {
		return nil, ErrOwnerUnavailable
	}
	// The caller's startup context owns the handshake, not the continuing
	// connection. Per-operation contexts still own every subsequent request.
	peer := localrpc.New(context.Background(), connection, func(context.Context, string, json.RawMessage) (any, error) { return nil, ErrOwnerProtocol })
	client := &Client{peer: peer, record: record}
	var actual hello
	if err := client.call(ctx, "owner.hello", struct{}{}, &actual); err != nil {
		peer.Close()
		return nil, err
	}
	if actual.Version != ProtocolVersion {
		peer.Close()
		return nil, ErrOwnerProtocol
	}
	if actual != helloFor(record) {
		peer.Close()
		return nil, ErrOwnerIdentityMismatch
	}
	return client, nil
}

func (client *Client) Created() bool { return client.created }

func (client *Client) Close() error {
	client.close.Do(func() { client.peer.Close() })
	return nil
}

func (client *Client) call(ctx context.Context, method string, request, result any) error {
	if err := operationContext(ctx); err != nil {
		return err
	}
	raw, err := client.peer.Call(ctx, method, request)
	if err != nil {
		for _, known := range []error{ErrOwnerUnavailable, ErrOwnerIdentityMismatch, ErrOwnerRecordInvalid, ErrOwnerProtocol, ErrOwnerConfiguration, ErrOwnerShutdown, ErrRuntimeUnavailable, harnessruntime.ErrInputInvalid, harnessruntime.ErrWorktreeInvalid, harnessruntime.ErrSpawnFailed, harnessruntime.ErrChildUnavailable, harnessruntime.ErrChildCrashed, harnessruntime.ErrNotFound, harnessruntime.ErrOperationInProgress, harnessruntime.ErrPortInUse, harnessruntime.ErrShutdownTimeout} {
			if err.Error() == known.Error() {
				return known
			}
		}
		if strings.HasPrefix(err.Error(), "runtime.") || err.Error() == "p2p.runtime_unavailable" || err.Error() == "p2p.request_cancelled" {
			return err
		}
		if ctx.Err() != nil {
			return errors.New("p2p.request_cancelled")
		}
		return ErrOwnerUnavailable
	}
	if protocol.DecodeExact(raw, result) != nil {
		return ErrOwnerProtocol
	}
	return nil
}

func (client *Client) Start(ctx context.Context, request harnessruntime.LaunchRequest) (harnessruntime.LaunchView, error) {
	var result launchResult
	if err := client.call(ctx, "owner.start", startWire(request), &result); err != nil {
		return harnessruntime.LaunchView{}, err
	}
	return decodeLaunch(result.Launch)
}

func (client *Client) Stop(ctx context.Context, subject string) (harnessruntime.LaunchView, error) {
	var result launchResult
	if err := client.call(ctx, "owner.stop", subjectRequest{subject}, &result); err != nil {
		return harnessruntime.LaunchView{}, err
	}
	return decodeLaunch(result.Launch)
}

func (client *Client) Status(ctx context.Context, subject string) (harnessruntime.LaunchView, bool, error) {
	var result statusResult
	if err := client.call(ctx, "owner.status", subjectRequest{subject}, &result); err != nil {
		return harnessruntime.LaunchView{}, false, err
	}
	if !result.Present {
		if string(result.Launch) != "{}" {
			return harnessruntime.LaunchView{}, false, ErrOwnerProtocol
		}
		return harnessruntime.LaunchView{}, false, nil
	}
	view, err := decodeLaunch(result.Launch)
	if err == nil && view.SubjectID != subject {
		err = ErrOwnerIdentityMismatch
	}
	return view, err == nil, err
}

func (client *Client) Console(ctx context.Context, cursor int64) ([]harnessruntime.ConsoleEntry, int64, error) {
	var result consoleResult
	err := client.call(ctx, "owner.console", consoleRequest{cursor}, &result)
	return result.Entries, result.Cursor, err
}

func (client *Client) Binding(ctx context.Context, subject string) (runtimebridge.Binding, error) {
	var result runtimebridge.Binding
	if err := client.call(ctx, "owner.binding", subjectRequest{subject}, &result); err != nil {
		return result, err
	}
	if result.Generation == 0 || !validBindingURL(result.URL) {
		return runtimebridge.Binding{}, ErrOwnerProtocol
	}
	return result, nil
}

// Shutdown waits for the real Run process, its endpoint and lifetime lock, not
// only a buffered RPC acknowledgement. Closing a normal client never does this.
func (client *Client) Shutdown(ctx context.Context) error {
	var result shutdownResult
	if err := client.call(ctx, "owner.shutdown", struct{}{}, &result); err != nil {
		return err
	}
	if !result.Stopped {
		return ErrOwnerShutdown
	}
	client.Close() // The owner exits only after its acknowledgement was received.
	directory := filepath.Join(client.record.Config.StateRoot, ownerDirectory)
	for {
		_, recordErr := readRecord(filepath.Join(directory, recordFileName))
		identity, identityErr := processIdentityAt(client.record.Process.PID)
		gone := identityErr != nil || identity != client.record.Process
		if errors.Is(recordErr, os.ErrNotExist) && gone {
			lease, err := localrpc.AcquireOwnerLock(ctx, directory, false)
			if err == nil {
				return lease.Release()
			}
		}
		select {
		case <-ctx.Done():
			return ErrOwnerShutdown
		case <-time.After(10 * time.Millisecond):
		}
	}
}

var _ harnessruntime.Authority = (*Client)(nil)
