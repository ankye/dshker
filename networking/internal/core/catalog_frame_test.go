package core

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"math/big"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/catalog"
	"github.com/ankye/dshker/networking/internal/localrpc"
	"github.com/ankye/dshker/networking/internal/protocol"
)

// TestCatalogRecordFitsOneControlFrame pins the size relationship the catalog
// routing depends on. The shell no longer reads p2p-devices.json itself:
// core.catalog_inspect answers with the whole record and core.catalog_commit
// carries one back, while localrpc refuses to write a frame larger than
// protocol.MaxControlBytes and silently drops the answer. A record the store
// accepts must therefore fit in one frame, in both directions, with room for
// the envelope.
func TestCatalogRecordFitsOneControlFrame(t *testing.T) {
	record := maximalCatalogRecord(t)
	encoded, err := json.Marshal(record)
	if err != nil {
		t.Fatalf("marshal record: %v", err)
	}
	if len(encoded) > catalog.MaxRecordBytes {
		t.Fatalf("fixture exceeds the store cap: %d > %d", len(encoded), catalog.MaxRecordBytes)
	}
	if len(encoded) < catalog.MaxRecordBytes-4096 {
		t.Fatalf("fixture does not probe the cap: %d of %d", len(encoded), catalog.MaxRecordBytes)
	}
	revision := hex.EncodeToString(make([]byte, 32))
	inspect, err := json.Marshal(catalogSnapshot(&catalog.Snapshot{Revision: revision, Record: record}))
	if err != nil {
		t.Fatalf("marshal inspect answer: %v", err)
	}
	commit, err := json.Marshal(struct {
		ExpectedRevision string         "json:\"expectedRevision\""
		Record           catalog.Record "json:\"record\""
	}{ExpectedRevision: revision, Record: record})
	if err != nil {
		t.Fatalf("marshal commit request: %v", err)
	}
	// A record is embedded in the frame verbatim, so the difference between the
	// two sizes is exactly the envelope. The worst case this must hold for is a
	// record at the cap, which no fixture can reach byte for byte.
	for name, payload := range map[string]json.RawMessage{
		"inspect answer": inspect,
		"commit request": commit,
	} {
		frame, err := json.Marshal(localrpc.Frame{Version: 1, ID: 9007199254740991, Payload: payload})
		if err != nil {
			t.Fatalf("marshal %s: %v", name, err)
		}
		envelope := len(frame) - len(encoded)
		if envelope <= 0 {
			t.Fatalf("%s does not embed the record verbatim: frame %d, record %d", name, len(frame), len(encoded))
		}
		if catalog.MaxRecordBytes+envelope > protocol.MaxControlBytes {
			t.Fatalf("%s: a record at the cap needs %d bytes of a %d byte frame",
				name, catalog.MaxRecordBytes+envelope, protocol.MaxControlBytes)
		}
	}
}

// maximalCatalogRecord builds a record the strict parser accepts and that is
// within a few kilobytes of the cap: one service plus computers padded with the
// longest display name the format allows.
func maximalCatalogRecord(t *testing.T) catalog.Record {
	t.Helper()
	service := maximalService(t)
	record := catalog.Record{
		Format:              "dshker.p2p-devices",
		Version:             1,
		CatalogID:           randomHex(t, 6),
		Services:            []catalog.Service{service},
		Computers:           []catalog.Computer{},
		ForgottenServiceIDs: []string{},
	}
	for len(record.Computers) < 400 {
		record.Computers = append(record.Computers, maximalComputer(t, service))
		encoded, err := json.Marshal(record)
		if err != nil {
			t.Fatalf("marshal partial record: %v", err)
		}
		if len(encoded) > catalog.MaxRecordBytes-2048 {
			if len(encoded) > catalog.MaxRecordBytes {
				record.Computers = record.Computers[:len(record.Computers)-1]
			}
			break
		}
	}
	encoded, err := json.Marshal(record)
	if err != nil {
		t.Fatalf("marshal record: %v", err)
	}
	if _, err := catalog.Parse(encoded); err != nil {
		t.Fatalf("fixture is not a valid record: %v", err)
	}
	return record
}

func maximalService(t *testing.T) catalog.Service {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("service key: %v", err)
	}
	digest := sha256.Sum256(public)
	template := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "frame-budget"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, public, private)
	if err != nil {
		t.Fatalf("service certificate: %v", err)
	}
	return catalog.Service{
		ServiceID:   hex.EncodeToString(digest[:6]),
		DisplayName: "frame-budget coordinator",
		HTTPSOrigin: "https://coordinator.example:8443",
		WSSURL:      "wss://coordinator.example:8443/v1/signals",
		STUNAddress: "coordinator.example:3478",
		PublicKey:   base64.StdEncoding.EncodeToString(public),
		Certificate: base64.StdEncoding.EncodeToString(der),
	}
}

// maximalComputer reuses one pair of keys on purpose: uniqueness is only
// required per record for the connection id and the service/pair key.
func maximalComputer(t *testing.T, service catalog.Service) catalog.Computer {
	t.Helper()
	local := make([]byte, 32)
	remote := make([]byte, 32)
	if _, err := rand.Read(local); err != nil {
		t.Fatalf("local key: %v", err)
	}
	if _, err := rand.Read(remote); err != nil {
		t.Fatalf("remote key: %v", err)
	}
	return catalog.Computer{
		ConnectionID:    randomHex(t, 6),
		ServiceID:       service.ServiceID,
		DisplayName:     maximalName(),
		PairID:          randomHex(t, 6),
		NetworkID:       randomHex(t, 6),
		LocalDeviceID:   randomHex(t, 6),
		RemoteDeviceID:  randomHex(t, 6),
		UserID:          randomHex(t, 6),
		LocalPublicKey:  base64.StdEncoding.EncodeToString(local),
		RemotePublicKey: base64.StdEncoding.EncodeToString(remote),
		PairRevision:    1,
		PairState:       "active",
	}
}

// maximalName is the longest display name the format allows.
func maximalName() string {
	name := make([]byte, 256)
	for index := range name {
		name[index] = 'a'
	}
	return string(name)
}

func randomHex(t *testing.T, size int) string {
	t.Helper()
	buf := make([]byte, size)
	if _, err := rand.Read(buf); err != nil {
		t.Fatalf("random: %v", err)
	}
	return hex.EncodeToString(buf)
}
