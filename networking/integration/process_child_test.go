package integration

// This driver exists only in the Go test binary. It exercises production controlplane
// and peer packages in separate OS processes, not the (unfinished) Electron helper.
import (
	"bufio"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"hash"
	"os"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/peer"
	"github.com/ankye/dshker/networking/internal/protocol"
)

type childConfig struct {
	Endpoints controlplane.Endpoints
	Root      []byte
	Authority controlplane.Identity
	Device    controlplane.Device
	Private   ed25519.PrivateKey
	Pin       controlplane.PairIdentity
}
type command struct {
	ID         int
	Op         string
	Config     *childConfig
	Generation uint64
	Data       []byte
	Count      int
}
type result struct {
	ID            int             `json:"id"`
	Event         string          `json:"event"`
	Error         string          `json:"error,omitempty"`
	Attempt       string          `json:"attempt,omitempty"`
	Expires       int64           `json:"expires,omitempty"`
	PID           int             `json:"pid,omitempty"`
	Packets       int             `json:"packets,omitempty"`
	Bytes         int             `json:"bytes,omitempty"`
	Digest        string          `json:"digest,omitempty"`
	Goroutines    int             `json:"goroutines,omitempty"`
	Heap          uint64          `json:"heap,omitempty"`
	Path          peer.DirectPath `json:"path"`
	ControlOnline bool            `json:"controlOnline"`
}
type childDriver struct {
	config         childConfig
	client         *controlplane.Client
	signals        *controlplane.Signals
	transport      *peer.Transport
	lease          protocol.Lease
	revoked        bool
	writeMu        sync.Mutex
	statsMu        sync.Mutex
	packets, bytes int
	digest         hash.Hash
	paused         atomic.Bool
}

func TestPeerProcess(t *testing.T) {
	if os.Getenv("DSHKER_TEST_PEER_PROCESS") != "1" {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	driver := &childDriver{digest: sha256.New()}
	err := driver.run(ctx)
	cancel()
	if driver.transport != nil {
		driver.transport.Close()
	}
	if driver.signals != nil {
		driver.signals.Close()
	}
	if driver.client != nil {
		driver.client.Close()
	}
	if err != nil {
		driver.emit(result{Event: "fatal", Error: err.Error()})
		os.Exit(1)
	}
	os.Exit(0)
}

func (d *childDriver) emit(value result) {
	d.writeMu.Lock()
	defer d.writeMu.Unlock()
	if json.NewEncoder(os.Stdout).Encode(value) != nil {
		os.Exit(2)
	}
}

func (d *childDriver) run(ctx context.Context) error {
	commands := make(chan command)
	go func() {
		defer close(commands)
		scanner := bufio.NewScanner(os.Stdin)
		scanner.Buffer(make([]byte, 4096), 256*1024)
		for scanner.Scan() {
			var input command
			if json.Unmarshal(scanner.Bytes(), &input) != nil {
				return
			}
			select {
			case commands <- input:
			case <-ctx.Done():
				return
			}
		}
	}()
	var events <-chan controlplane.SignalEvent
	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case input, ok := <-commands:
			if !ok {
				return nil
			}
			value, err := d.execute(ctx, input)
			value.ID = input.ID
			if err != nil {
				value.Error = err.Error()
			}
			d.emit(value)
			if d.signals != nil {
				events = d.signals.Events()
			}
		case event, ok := <-events:
			if !ok {
				events = nil
				d.emit(result{Event: "control-offline"})
				continue
			}
			if err := d.signal(ctx, event); err != nil {
				d.emit(result{Event: "signal-error", Error: err.Error()})
			}
		case <-ticker.C:
			if d.transport == nil {
				continue
			}
			select {
			case <-d.transport.Done():
				continue
			default:
			}
			lease, err := d.client.RenewLease(ctx, d.lease.PairID, d.lease.AttemptID)
			if err == nil {
				err = d.transport.UpdateLease(lease)
			}
			if err == nil {
				d.lease = lease
				d.emit(result{Event: "renewed", Attempt: lease.AttemptID, Expires: lease.ExpiresAt})
			} else {
				d.emit(result{Event: "renew-failed", Error: err.Error()})
				if err.Error() != "p2p.server_unavailable" {
					d.transport.Close()
				}
			}
		}
	}
}

func (d *childDriver) execute(ctx context.Context, input command) (result, error) {
	value := result{Event: input.Op}
	if input.Op == "init" {
		if d.client != nil || input.Config == nil {
			return value, errors.New("invalid test init")
		}
		d.config = *input.Config
		cert, err := x509.ParseCertificate(d.config.Root)
		if err != nil {
			return value, err
		}
		roots := x509.NewCertPool()
		roots.AddCert(cert)
		base, err := controlplane.New(d.config.Endpoints, roots)
		if err != nil {
			return value, err
		}
		defer base.Close()
		if _, err = base.Identity(ctx, d.config.Authority.PublicKey); err != nil {
			return value, err
		}
		d.client, err = base.WithDevice(d.config.Device, d.config.Private, d.config.Authority)
		if err != nil {
			return value, err
		}
		d.signals, err = d.client.Subscribe(ctx, d.config.Device.DeviceID)
		value.PID = os.Getpid()
		return value, err
	}
	if d.client == nil {
		return value, errors.New("test driver not initialized")
	}
	switch input.Op {
	case "connect":
		pin := d.config.Pin
		local, remote := pin.Initiator, pin.Target
		if local.DeviceID != d.config.Device.DeviceID {
			local, remote = remote, local
		}
		if d.revoked {
			return value, errors.New("p2p.pair_unauthorized")
		}
		// The coordinator authorizes by network co-membership: the attempt
		// targets the other device identity of the confirmed pair.
		lease, err := d.client.Begin(ctx, remote.DeviceID, input.Generation)
		if err != nil {
			return value, err
		}
		if err = d.start(ctx, lease); err != nil {
			return value, err
		}
		deadline, stop := context.WithTimeout(ctx, 30*time.Second)
		defer stop()
		offer, err := d.transport.Offer(deadline)
		if err != nil {
			return value, err
		}
		err = d.signals.Send(deadline, offer)
		value.Attempt, value.Expires = lease.AttemptID, lease.ExpiresAt
		return value, err
	case "send":
		if d.transport == nil {
			return value, errors.New("p2p.direct_closed")
		}
		if input.Count < 1 || input.Count > 256 {
			return value, errors.New("invalid test send count")
		}
		for range input.Count {
			if err := d.transport.Send(input.Data); err != nil {
				return value, err
			}
			value.Packets++
		}
	case "disconnect":
		if d.transport == nil {
			return value, errors.New("p2p.direct_closed")
		}
		d.transport.Close()
		return value, d.client.End(ctx, d.lease.PairID, d.lease.AttemptID)
	case "close-local":
		if d.transport != nil {
			d.transport.Close()
		}
	case "pause-reader":
		d.paused.Store(true)
	case "status":
		d.statsMu.Lock()
		value.Packets, value.Bytes, value.Digest = d.packets, d.bytes, hex.EncodeToString(d.digest.Sum(nil))
		d.statsMu.Unlock()
		var memory runtime.MemStats
		runtime.ReadMemStats(&memory)
		value.Heap, value.Goroutines = memory.HeapAlloc, runtime.NumGoroutine()
		value.Attempt, value.Expires = d.lease.AttemptID, d.lease.ExpiresAt
		if d.signals != nil {
			select {
			case <-d.signals.Done():
			default:
				value.ControlOnline = true
			}
		}
		if d.transport != nil {
			select {
			case <-d.transport.Done():
				value.Error = "p2p.direct_closed"
			default:
			}
		}
	default:
		return value, errors.New("invalid test operation")
	}
	return value, nil
}

func (d *childDriver) start(ctx context.Context, lease protocol.Lease) error {
	pin := d.config.Pin
	local, remote := pin.Initiator, pin.Target
	if local.DeviceID != d.config.Device.DeviceID {
		local, remote = remote, local
	}
	// The lease identifies the far side by device identity (co-membership):
	// outgoing attempts name the target, incoming attempts name this device
	// while FromDeviceID is the initiator.
	if d.revoked || local.DeviceID != d.config.Device.DeviceID || pin.Pair.State != "active" {
		return errors.New("p2p.pair_unauthorized")
	}
	if lease.PairID != remote.DeviceID && lease.FromDeviceID != remote.DeviceID {
		return errors.New("p2p.pair_unauthorized")
	}
	if !ed25519.PublicKey(local.PublicKey).Equal(ed25519.PublicKey(d.config.Device.PublicKey)) {
		return errors.New("p2p.identity_mismatch")
	}
	if d.transport != nil {
		d.transport.Close()
	}
	scope := protocol.SignalScope{PairID: lease.PairID, AttemptID: lease.AttemptID, Generation: lease.Generation, FromDeviceID: lease.FromDeviceID, ToDeviceID: lease.ToDeviceID}
	transport, err := peer.NewTransport(ctx, peer.TransportOptions{UserID: d.config.Device.UserID, NetworkID: pin.Pair.NetworkID, STUNAddress: d.config.Endpoints.STUNAddress, LocalDeviceID: local.DeviceID, PeerDeviceID: remote.DeviceID, PrivateKey: d.config.Private, PeerKey: remote.PublicKey, ServiceKey: d.config.Authority.PublicKey, Scope: scope, Revision: lease.Revision, Lease: lease})
	if err != nil {
		return err
	}
	d.transport, d.lease = transport, lease
	go func() {
		deadline, stop := context.WithTimeout(ctx, 30*time.Second)
		defer stop()
		if err := transport.WaitReady(deadline); err != nil {
			d.emit(result{Event: "failed", Attempt: lease.AttemptID, Error: err.Error()})
			transport.Close()
			return
		}
		path, err := transport.Path()
		if err != nil {
			d.emit(result{Event: "failed", Error: err.Error()})
			return
		}
		d.emit(result{Event: "ready", Attempt: lease.AttemptID, Path: path})
		for {
			messages := transport.Messages()
			if d.paused.Load() {
				messages = nil
			}
			select {
			case data := <-messages:
				d.statsMu.Lock()
				d.packets++
				d.bytes += len(data)
				d.digest.Write(data)
				d.statsMu.Unlock()
			case <-transport.Done():
				code := "p2p.direct_closed"
				select {
				case err := <-transport.Errors():
					code = err.Error()
				default:
				}
				d.emit(result{Event: "closed", Attempt: lease.AttemptID, Error: code})
				return
			case <-time.After(10 * time.Millisecond):
			}
		}
	}()
	return nil
}

func (d *childDriver) signal(ctx context.Context, event controlplane.SignalEvent) error {
	switch event.Type {
	case "attempt":
		return d.start(ctx, event.Lease)
	case "revoked":
		// Revocation events carry the pair record id, which stays the local
		// key of the confirmed pair even though leases name the target device.
		// The coordinator no longer consults pair records for attempts, so the
		// local side refuses a revoked pair itself.
		if event.PairID == d.config.Pin.Pair.PairID {
			d.revoked = true
			if d.transport != nil {
				d.transport.Close()
				d.emit(result{Event: "revoked", Attempt: d.lease.AttemptID})
			}
		}
	case "signal":
		if d.transport == nil || event.Signal.AttemptID != d.lease.AttemptID {
			return errors.New("p2p.signal_state_conflict")
		}
		deadline, stop := context.WithTimeout(ctx, 30*time.Second)
		defer stop()
		if event.Signal.Type == "offer" {
			answer, err := d.transport.AcceptOffer(deadline, event.Signal)
			if err != nil {
				return err
			}
			return d.signals.Send(deadline, answer)
		}
		return d.transport.AcceptAnswer(event.Signal)
	}
	return nil
}
