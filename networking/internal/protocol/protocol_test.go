package protocol

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestStrictJSON(t *testing.T) {
	for _, input := range []string{`{"sdp":"x","sdp":"y"}`, `{"sdp":"x","extra":1}`, `null`, `{"sdp":null}`, `{"sdp":"x"} {}`, `[]`, strings.Repeat(" ", MaxControlBytes+1)} {
		t.Run(input[:min(len(input), 60)], func(t *testing.T) {
			var target SDP
			if Decode([]byte(input), &target) == nil {
				t.Fatal("accepted ambiguous or invalid input")
			}
		})
	}
	var target SDP
	if err := Decode([]byte(`{"sdp":"v=0\r\n"}`), &target); err != nil || target.SDP != "v=0\r\n" {
		t.Fatalf("valid field changed: %q %v", target.SDP, err)
	}
}

func TestSignalExpiry(t *testing.T) {
	issued := time.Unix(1700000000, 0)
	expiry := SignalExpiry(issued)
	// A signal issued with SignalExpiry is accepted at issue time, with a
	// receiver clock up to 15s ahead, and rejected once the window passes.
	if expiry <= issued.Unix() || expiry > issued.Add(SignalValidity).Unix() {
		t.Fatalf("SignalExpiry outside validity window: %d", expiry)
	}
	if SignalExpiry(issued) != expiry {
		t.Fatal("SignalExpiry not deterministic")
	}
	accept := []time.Time{issued, issued.Add(14 * time.Second)}
	for _, at := range accept {
		if expiry <= at.Unix() || expiry > at.Add(SignalValidity).Unix() {
			t.Fatalf("signal issued at %d rejected by receiver at %d", issued.Unix(), at.Unix())
		}
	}
	late := issued.Add(SignalValidity + time.Second)
	if expiry > late.Unix() {
		t.Fatal("signal still valid after its window")
	}
}

func TestSignalSignatureAndScope(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Unix(1700000000, 0)
	scope := SignalScope{NewID(), NewID(), NewID(), NewID(), 1, 1}
	body, _ := json.Marshal(SDP{"v=0\r\n"})
	signal := Signal{Version, "offer", NewID(), scope.AttemptID, 1, scope.FromDeviceID, scope.ToDeviceID, scope.PairID, 1, now.Unix() + 60, base64.RawURLEncoding.EncodeToString(body), ""}
	signal.Sign(private)
	if err := signal.Verify(public, scope, now); err != nil {
		t.Fatal(err)
	}
	mutations := map[string]func(*Signal){
		"version":    func(s *Signal) { s.Version++ },
		"sender":     func(s *Signal) { s.FromDeviceID = NewID() },
		"target":     func(s *Signal) { s.ToDeviceID = NewID() },
		"attempt":    func(s *Signal) { s.AttemptID = NewID() },
		"pair":       func(s *Signal) { s.PairID = NewID() },
		"sequence":   func(s *Signal) { s.Sequence++ },
		"generation": func(s *Signal) { s.Generation++ },
		"expiry":     func(s *Signal) { s.ExpiresAt = now.Unix() },
		"future":     func(s *Signal) { s.ExpiresAt++ },
		"payload":    func(s *Signal) { s.Payload = "e30" },
		"type":       func(s *Signal) { s.Type = "business" },
		"signature":  func(s *Signal) { s.Signature = "invalid" },
	}
	for name, change := range mutations {
		t.Run(name, func(t *testing.T) {
			copy := signal
			change(&copy)
			if copy.Verify(public, scope, now) == nil {
				t.Fatal("accepted modified signal")
			}
		})
	}
	encoded, _ := json.Marshal(signal)
	var decoded Signal
	if err := Decode(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded != signal {
		t.Fatal("wire readback changed signed fields")
	}
	scope.NextSequence++
	if decoded.Verify(public, scope, now) == nil {
		t.Fatal("accepted replay")
	}
}

func TestSigningGolden(t *testing.T) {
	signal := Signal{Version: 1, Type: "offer", MessageID: "message", AttemptID: "attempt", Generation: 2, FromDeviceID: "from", ToDeviceID: "to", PairID: "pair", Sequence: 3, ExpiresAt: 4, Payload: "body"}
	expected := `["dshker.signal.v1",1,"offer","message","attempt",2,"from","to","pair",3,4,"body"]`
	if string(signal.SigningBytes()) != expected {
		t.Fatal(string(signal.SigningBytes()))
	}
}

func TestFrameLimitsAndGeneration(t *testing.T) {
	attempt := NewID()
	frame := Frame{Version, "DATA", attempt, 1, 2, 1, 0, make([]byte, MaxDataBytes)}
	if err := frame.Validate(attempt, 1, 2); err != nil {
		t.Fatal(err)
	}
	frame.Data = append(frame.Data, 0)
	if frame.Validate(attempt, 1, 2) == nil {
		t.Fatal("accepted oversized data")
	}
	frame.Data = []byte{}
	frame.Type = "OPEN"
	frame.Credit = MaxQueueBytes
	if err := frame.Validate(attempt, 1, 2); err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"FIN", "RESET"} {
		frame.Type, frame.Credit = kind, 0
		if err := frame.Validate(attempt, 1, 2); err != nil {
			t.Fatal(err)
		}
		if frame.Validate(attempt, 2, 2) == nil || frame.Validate(attempt, 1, 3) == nil || frame.Validate(NewID(), 1, 2) == nil {
			t.Fatal("accepted stale or cross-peer frame")
		}
	}
}
