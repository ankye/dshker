package peer

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/protocol"
)

func TestCandidateLeaseReadbackNeverRegressesConcurrentRenewal(t *testing.T) {
	options, _ := optionsPair(t)
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	options.ServiceKey = public
	options.Scope.AttemptID = protocol.NewNonce()
	options.Lease.AttemptID, options.Lease.ServiceID = options.Scope.AttemptID, protocol.KeyID(public)
	options.Lease.PairID, options.Scope.PairID = options.Lease.ToDeviceID, options.Lease.ToDeviceID
	options.Lease.Signature = base64.RawURLEncoding.EncodeToString(ed25519.Sign(private, options.Lease.SigningBytes()))
	ticket := protocol.CandidateTicket{Version: 1, Lease: options.Lease, ServerEpoch: protocol.NewNonce(), FromCoreInstanceID: protocol.NewNonce(), ToCoreInstanceID: protocol.NewNonce(), PrepareDeadline: time.Now().Add(2 * time.Minute).Unix()}
	ticket.Sign(private)
	options.Ticket = &ticket
	transport, err := NewTransport(context.Background(), options)
	if err != nil {
		t.Fatal(err)
	}
	defer transport.Close()
	renewed := options.Lease
	renewed.ExpiresAt += 10
	renewed.Signature = base64.RawURLEncoding.EncodeToString(ed25519.Sign(private, renewed.SigningBytes()))
	if err := transport.UpdateLease(renewed); err != nil {
		t.Fatal(err)
	}
	if err := transport.UpdateLease(ticket.Lease); err != nil {
		t.Fatal("late authenticated state invalidated a newer live lease", err)
	}
	transport.mu.Lock()
	actual := transport.lease
	transport.mu.Unlock()
	if actual != renewed {
		t.Fatal("late readback shortened the accepted lease")
	}
}
