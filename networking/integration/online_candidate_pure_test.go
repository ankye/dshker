//go:build live

package integration

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/hex"
	"errors"
	"math/big"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/protocol"
)

// These pure admission checks never create a client, launch DSH or contact the
// online origin. They can run before the separately authorized external gate.
func TestOnlineCandidateInputsRequireEveryExplicitOwner(t *testing.T) {
	values := map[string]string{
		"DSHKER_ONLINE_HTTPS_ORIGIN":       "https://online.example.test:8443",
		"DSHKER_ONLINE_WSS_URL":            "wss://online.example.test:8443/v1/signals",
		"DSHKER_ONLINE_STUN_ADDRESS":       "online.example.test:3478",
		"DSHKER_ONLINE_SERVICE_ID":         "aabbccddeeff",
		"DSHKER_ONLINE_PUBLIC_SPKI_SHA256": strings.Repeat("ab", 32),
		"DSHKER_TEST_HARNESS_ROOT":         filepath.Join(t.TempDir(), "explicit-harness"),
	}
	getenv := func(name string) string { return values[name] }
	if _, err := readOnlineCandidateInputs(getenv); err != nil {
		t.Fatal("fully explicit input was rejected")
	}
	for key := range values {
		t.Run(key, func(t *testing.T) {
			original := values[key]
			values[key] = ""
			defer func() { values[key] = original }()
			if _, err := readOnlineCandidateInputs(getenv); err == nil {
				t.Fatal("missing explicit owner was accepted")
			}
		})
	}
	for _, change := range []struct{ key, value string }{
		{"DSHKER_ONLINE_WSS_URL", "wss://another.example.test:8443/v1/signals"},
		{"DSHKER_ONLINE_HTTPS_ORIGIN", "http://online.example.test:8443"},
		{"DSHKER_ONLINE_SERVICE_ID", "AABBCCDDEEFF"},
		{"DSHKER_ONLINE_SERVICE_ID", "aabb"},
		{"DSHKER_ONLINE_PUBLIC_SPKI_SHA256", strings.Repeat("ab", 31)},
		{"DSHKER_ONLINE_PUBLIC_SPKI_SHA256", strings.Repeat("AB", 32)},
		{"DSHKER_TEST_HARNESS_ROOT", "relative-harness"},
	} {
		original := values[change.key]
		values[change.key] = change.value
		_, err := readOnlineCandidateInputs(getenv)
		values[change.key] = original
		if err == nil {
			t.Fatalf("invalid explicit owner accepted for %s", change.key)
		}
	}
}

func TestOnlineCandidatePasswordOnlyAcceptsOneBoundedStdinLine(t *testing.T) {
	valid := strings.Repeat("a1", 32)
	for _, input := range []string{"", "\n", "short\n", valid, valid + "\r\n", " " + valid + "\n", valid + "\nsecond\n", strings.Repeat("a", 4096) + "\n", valid + "\x00\n"} {
		if _, err := readOnlineCandidatePassword(strings.NewReader(input)); err == nil {
			t.Fatal("invalid or ambiguous stdin secret was accepted")
		}
	}
	actual, err := readOnlineCandidatePassword(strings.NewReader(valid + "\n"))
	if err != nil || actual != valid {
		t.Fatal("single explicit stdin secret was changed or rejected")
	}
}

func TestOnlineCandidateIdentityPinRejectsAnotherServiceAndSPKI(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(1), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign, NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour)}
	der, err := x509.CreateCertificate(rand.Reader, template, template, public, private)
	if err != nil {
		t.Fatal(err)
	}
	certificate, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(certificate.RawSubjectPublicKeyInfo)
	inputs := onlineCandidateInputs{serviceID: protocol.KeyID(public), publicSPKI: hex.EncodeToString(digest[:])}
	identity := controlplane.Identity{ServiceID: inputs.serviceID, PublicKey: public, Certificate: der}
	if err := onlineCandidateIdentity(inputs, identity); err != nil {
		t.Fatal("exact external service and SPKI pin was rejected")
	}
	wrongService := identity
	wrongService.ServiceID = protocol.NewID()
	if err := onlineCandidateIdentity(inputs, wrongService); err == nil {
		t.Fatal("another service ID passed the external pin")
	}
	wrongSPKI := inputs
	wrongSPKI.publicSPKI = strings.Repeat("00", sha256.Size)
	if err := onlineCandidateIdentity(wrongSPKI, identity); err == nil {
		t.Fatal("another public SPKI passed the external pin")
	}
	broken := identity
	broken.Certificate = []byte("invalid certificate")
	if err := onlineCandidateIdentity(inputs, broken); err == nil {
		t.Fatal("invalid identity certificate passed the external pin")
	}
}

func TestOnlineCandidateReadyRequiresExactOwnersAndServerSupport(t *testing.T) {
	device, user, coreID := protocol.NewID(), protocol.NewID(), protocol.NewNonce()
	ready := protocol.ControlReady{Version: protocol.ControlVersion, Type: "ready", DeviceID: device, UserID: user, Registration: protocol.RegistrationFence{ServerEpoch: protocol.NewNonce(), SubscriptionID: protocol.NewNonce(), CoreInstanceID: coreID}, Capabilities: []string{protocol.CapabilityCandidate}}
	for _, helloCapabilities := range [][]string{{}, {protocol.CapabilityCandidate}} {
		// Hello records this device's advertisement. Ready records the server's
		// support, so both advertisements receive the same server support set.
		if !protocol.ValidControlCapabilities(helloCapabilities) || !onlineCandidateReadyValid(ready, device, user, coreID) {
			t.Fatal("frozen server ready rejected for valid read-only or active Hello")
		}
	}
	for _, change := range []func(*protocol.ControlReady){
		func(value *protocol.ControlReady) { value.Capabilities = []string{} },
		func(value *protocol.ControlReady) { value.Capabilities = nil },
		func(value *protocol.ControlReady) {
			value.Capabilities = []string{protocol.CapabilityCandidate, protocol.CapabilityCandidate}
		},
		func(value *protocol.ControlReady) { value.UserID = protocol.NewID() },
		func(value *protocol.ControlReady) { value.DeviceID = protocol.NewID() },
		func(value *protocol.ControlReady) { value.Registration.CoreInstanceID = protocol.NewNonce() },
		func(value *protocol.ControlReady) { value.Registration.ServerEpoch = "" },
		func(value *protocol.ControlReady) { value.Registration.SubscriptionID = "" },
		func(value *protocol.ControlReady) { value.Version = 1 },
		func(value *protocol.ControlReady) { value.Type = "hello" },
	} {
		invalid := ready
		change(&invalid)
		if onlineCandidateReadyValid(invalid, device, user, coreID) {
			t.Fatal("v2 ready admitted missing support or another user/device/core/fence")
		}
	}
}

func TestOnlineCandidateWorkersCancelCloseAndJoinBeforeScopeCleanup(t *testing.T) {
	owner := newOnlineCandidateWorkers(context.Background())
	resource, closeResource := context.WithCancel(context.Background())
	defer closeResource()
	if !owner.addResource(closeResource) {
		t.Fatal("resource owner registration failed")
	}
	entered, exited, lateResult := make(chan struct{}), make(chan struct{}), make(chan bool, 1)
	if !owner.start(context.Background(), func(operation context.Context) {
		close(entered)
		// Models the production engine's independently owned Connect context:
		// caller cancellation alone cannot finish it; Host.Close must cancel it.
		<-resource.Done()
		<-operation.Done()
		lateResult <- owner.publish(operation, func() { t.Error("late result published during teardown") })
		close(exited)
	}) {
		t.Fatal("owned worker did not start")
	}
	<-entered
	cleanup, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := owner.stop(cleanup); err != nil {
		t.Fatal("cancel/Close/join did not complete within independent cleanup bound")
	}
	if !owner.isJoined() || <-lateResult || owner.start(context.Background(), func(context.Context) {}) || owner.addResource(func() {}) {
		t.Fatal("stopped owner accepted late results, new work or new resources")
	}
	select {
	case <-exited:
		// Only this joined state permits the fixture's remote scope deletion.
	default:
		t.Fatal("scope cleanup would precede worker exit")
	}
}

func TestOnlineCandidateWorkersRejectDeadlineResultsBeforeOwnerStop(t *testing.T) {
	owner := newOnlineCandidateWorkers(context.Background())
	operation, cancel := context.WithCancel(context.Background())
	entered, rejected := make(chan struct{}), make(chan bool, 1)
	if !owner.start(operation, func(child context.Context) {
		close(entered)
		<-child.Done()
		rejected <- !owner.publish(child, func() { t.Error("expired business result was published") })
	}) {
		t.Fatal("owned worker did not start")
	}
	<-entered
	cancel()
	if !<-rejected {
		t.Fatal("expired business work published a result before teardown")
	}
	cleanup, stop := context.WithTimeout(context.Background(), time.Second)
	defer stop()
	if err := owner.stop(cleanup); err != nil || !owner.isJoined() {
		t.Fatal("expired business worker was not joined")
	}
}

func TestOnlineCandidateWorkersDoNotPermitScopeCleanupOnJoinTimeout(t *testing.T) {
	owner := newOnlineCandidateWorkers(context.Background())
	entered, release := make(chan struct{}), make(chan struct{})
	if !owner.start(context.Background(), func(context.Context) {
		close(entered)
		<-release
	}) {
		t.Fatal("owned worker did not start")
	}
	<-entered
	cleanup, cancel := context.WithCancel(context.Background())
	cancel()
	if err := owner.stop(cleanup); !errors.Is(err, context.Canceled) || owner.isJoined() {
		t.Fatal("unfinished cleanup was treated as a joined owner")
	}
	close(release)
	joined, stop := context.WithTimeout(context.Background(), time.Second)
	defer stop()
	if err := owner.stop(joined); err != nil || !owner.isJoined() {
		t.Fatal("released worker could not complete its original teardown")
	}
}
