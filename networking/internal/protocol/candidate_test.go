package protocol

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

func candidateFixture() (CandidateTicket, ed25519.PrivateKey) {
	key := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{1}, 32))
	lease := Lease{Version: 1, ServiceID: KeyID(key.Public().(ed25519.PublicKey)), UserID: "aaaaaaaaaaaa", NetworkID: "bbbbbbbbbbbb",
		PairID: "dddddddddddd", AttemptID: strings.Repeat("1", 32), FromDeviceID: "cccccccccccc", ToDeviceID: "dddddddddddd",
		Generation: 7, Revision: 1, ExpiresAt: 1700000060, Permission: "dsh-session"}
	lease.Signature = base64.RawURLEncoding.EncodeToString(ed25519.Sign(key, lease.SigningBytes()))
	ticket := CandidateTicket{Version: 1, Lease: lease, ServerEpoch: strings.Repeat("5", 32), PreviousAttemptID: strings.Repeat("2", 32),
		PreviousGeneration: 6, FromCoreInstanceID: strings.Repeat("3", 32), ToCoreInstanceID: strings.Repeat("4", 32), PrepareDeadline: 1700000120}
	ticket.Sign(key)
	return ticket, key
}

func TestCandidateTicketAuthenticityTimeAndStrictAttemptIsolation(t *testing.T) {
	ticket, key := candidateFixture()
	public := key.Public().(ed25519.PublicKey)
	if err := ticket.Verify(public); err != nil {
		t.Fatal("valid candidate wrapper rejected", err)
	}
	for _, mutation := range []func(*CandidateTicket){
		func(value *CandidateTicket) { value.Version++ },
		func(value *CandidateTicket) { value.ServerEpoch = strings.Repeat("6", 32) },
		func(value *CandidateTicket) { value.PreviousAttemptID = strings.Repeat("7", 32) },
		func(value *CandidateTicket) { value.PreviousGeneration++ },
		func(value *CandidateTicket) { value.FromCoreInstanceID = strings.Repeat("8", 32) },
		func(value *CandidateTicket) { value.ToCoreInstanceID = strings.Repeat("9", 32) },
		func(value *CandidateTicket) { value.PrepareDeadline++ },
		func(value *CandidateTicket) { value.Lease.Signature = "tampered" },
		func(value *CandidateTicket) { value.Lease.Generation++ },
		func(value *CandidateTicket) { value.Lease.FromDeviceID = strings.Repeat("c", 32) },
		func(value *CandidateTicket) { value.Lease.AttemptID = NewID() },
	} {
		modified := ticket
		mutation(&modified)
		if modified.Verify(public) == nil {
			t.Fatal("candidate scope tampering was accepted", modified)
		}
	}
	lease := ticket.Lease
	if lease.VerifyCandidate(public, ticket, time.Unix(1700000000, 0)) != nil {
		t.Fatal("ticket-authorized 128-bit attempt lease rejected")
	}
	scope := SignalScope{AttemptID: lease.AttemptID, PairID: lease.PairID, FromDeviceID: lease.FromDeviceID, ToDeviceID: lease.ToDeviceID, Generation: lease.Generation}
	if lease.Verify(public, scope, lease.UserID, lease.NetworkID, 1, time.Unix(1700000000, 0)) == nil {
		t.Fatal("legacy lease admitted 128-bit attempt without candidate authorization")
	}
	if ticket.Verify(public) != nil || lease.VerifyCandidate(public, ticket, time.Unix(1700000200, 0)) == nil {
		t.Fatal("immutable receipt and current lease time permission were conflated")
	}
	lease.ExpiresAt = 1700000100
	lease.Signature = base64.RawURLEncoding.EncodeToString(ed25519.Sign(key, lease.SigningBytes()))
	if lease.VerifyCandidate(public, ticket, time.Unix(1700000050, 0)) != nil || ticket.Lease.ExpiresAt != 1700000060 {
		t.Fatal("renewal mutated immutable candidate ticket")
	}
}

func TestCandidateControlStrictNestedFields(t *testing.T) {
	ticket, _ := candidateFixture()
	request := CandidateAction{Registration: RegistrationFence{ServerEpoch: strings.Repeat("a", 32), SubscriptionID: strings.Repeat("b", 32), CoreInstanceID: strings.Repeat("c", 32)}, Ticket: ticket}
	encoded, _ := json.Marshal(request)
	var decoded CandidateAction
	if err := DecodeControl(encoded, &decoded); err != nil {
		t.Fatal("valid candidate action refused", err)
	}
	for _, body := range []string{
		strings.Replace(string(encoded), `"subscriptionId":"`+request.Registration.SubscriptionID+`",`, "", 1),
		strings.Replace(string(encoded), `"serverEpoch"`, `"ServerEpoch"`, 1),
		strings.Replace(string(encoded), `"registration":{`, `"registration":{"unknown":1,`, 1),
		strings.Replace(string(encoded), `"registration":{`, `"registration":{"serverEpoch":"duplicate",`, 1),
		strings.Replace(string(encoded), `"registration":{`, `"registration":null,"extra":{`, 1),
	} {
		if DecodeControl([]byte(body), &decoded) == nil {
			t.Fatal("nested candidate field admission accepted malformed input", body)
		}
	}
}

func TestCandidateWireGolden(t *testing.T) {
	ticket, key := candidateFixture()
	var golden struct {
		PublicKey    []byte          `json:"publicKey"`
		Ticket       CandidateTicket `json:"ticket"`
		SigningBytes string          `json:"signingBytes"`
	}
	encoded, err := os.ReadFile("testdata/candidate-v1.json")
	if err != nil || DecodeControl(encoded, &golden) != nil {
		t.Fatal("candidate golden is invalid", err)
	}
	if !bytes.Equal(golden.PublicKey, key.Public().(ed25519.PublicKey)) || !bytes.Equal(golden.Ticket.SigningBytes(), ticket.SigningBytes()) ||
		golden.Ticket.Signature != ticket.Signature || golden.SigningBytes != string(ticket.SigningBytes()) || golden.Ticket.Verify(golden.PublicKey) != nil {
		t.Fatal("candidate signing bytes drifted from shared wire fixture")
	}
}

func TestCandidateAttemptSignalAndFrameKeepIdentityAdmissionNarrow(t *testing.T) {
	ticket, key := candidateFixture()
	lease := ticket.Lease
	now := time.Unix(1700000000, 0)
	body, _ := json.Marshal(SDP{SDP: "v=0\r\n"})
	scope := SignalScope{AttemptID: lease.AttemptID, FromDeviceID: lease.FromDeviceID, ToDeviceID: lease.ToDeviceID, PairID: lease.PairID, Generation: lease.Generation, NextSequence: 1}
	signal := Signal{Version: 1, Type: "offer", MessageID: NewID(), AttemptID: lease.AttemptID, Generation: lease.Generation, FromDeviceID: lease.FromDeviceID, ToDeviceID: lease.ToDeviceID, PairID: lease.PairID, Sequence: 1, ExpiresAt: now.Add(45 * time.Second).Unix(), Payload: base64.RawURLEncoding.EncodeToString(body)}
	signal.Sign(key)
	public := key.Public().(ed25519.PublicKey)
	if signal.VerifyCandidate(public, public, ticket, scope, now) != nil || signal.Verify(public, scope, now) == nil {
		t.Fatal("32hex signaling admission bypassed its candidate wrapper or failed legitimate v2")
	}
	frame := Frame{Version: 1, Type: "OPEN", AttemptID: lease.AttemptID, Generation: lease.Generation, RuntimeGeneration: 7, StreamID: 1, Credit: 1, Data: []byte{}}
	if frame.Validate(lease.AttemptID, lease.Generation, 7) != nil || frame.Validate(NewNonce(), lease.Generation, 7) == nil || frame.Validate(lease.AttemptID, lease.Generation, 8) == nil {
		t.Fatal("candidate frame lost exact attempt/runtime scope")
	}
	if ValidID(lease.AttemptID) {
		t.Fatal("v2 attempt widened global identity admission")
	}
	signal.FromDeviceID = NewNonce()
	signal.Sign(key)
	if signal.VerifyCandidate(public, public, ticket, scope, now) == nil {
		t.Fatal("32hex device identity entered v2 signaling")
	}
}
