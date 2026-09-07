package integration

import (
	"bytes"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/protocol"
)

func TestEnrollmentResultReadbackAndServerRestart(t *testing.T) {
	f := newFixture(t)
	// Keep fixture setup separate from the server's normal per-source rate window.
	time.Sleep(time.Second)
	grant, err := f.client.EnrollmentToken(f.ctx, f.userSession.Token, f.config[0].Pin.Pair.NetworkID)
	must(t, err)
	private, csr, err := controlplane.NewDeviceKey()
	must(t, err)
	requestID := protocol.NewID()
	original, err := f.client.Enroll(f.ctx, controlplane.Enrollment{RequestID: requestID, Token: grant.Token, CSR: csr, Name: "enrollment-readback"})
	must(t, err)
	// Treat the write response as unavailable to the recovery client. Only the
	// independent test oracle retains it, to compare exact persisted identity.
	actual, err := f.client.ReadEnrollment(f.ctx, requestID, private, f.authority)
	must(t, err)
	assertEnrollmentIdentity(t, original, actual)
	wrongKey, _, err := controlplane.NewDeviceKey()
	must(t, err)
	_, err = f.client.ReadEnrollment(f.ctx, requestID, wrongKey, f.authority)
	if err == nil || err.Error() != "p2p.enrollment_not_found" {
		t.Fatalf("foreign key recovered enrollment: %v", err)
	}
	_, err = f.client.ReadEnrollment(f.ctx, protocol.NewID(), private, f.authority)
	if err == nil || err.Error() != "p2p.enrollment_not_found" {
		t.Fatalf("foreign request recovered enrollment: %v", err)
	}
	f.server.stop(t, false)
	f.startServer(t)
	afterRestart, err := f.client.ReadEnrollment(f.ctx, requestID, private, f.authority)
	must(t, err)
	assertEnrollmentIdentity(t, original, afterRestart)
	devices, err := f.client.UserDevices(f.ctx, f.userSession.Token)
	must(t, err)
	if len(devices) != 3 {
		t.Fatalf("readback created duplicate devices: %d", len(devices))
	}
	_, err = f.client.Enroll(f.ctx, controlplane.Enrollment{RequestID: protocol.NewID(), Token: grant.Token, CSR: csr, Name: "must-not-re-enroll"})
	if err == nil || err.Error() != "p2p.invalid_enrollment_token" {
		t.Fatalf("single-use token was restored by readback: %v", err)
	}
}

func assertEnrollmentIdentity(t *testing.T, expected, actual controlplane.Device) {
	t.Helper()
	if expected.DeviceID != actual.DeviceID || expected.UserID != actual.UserID || expected.Name != actual.Name || !bytes.Equal(expected.PublicKey, actual.PublicKey) || !bytes.Equal(expected.Certificate, actual.Certificate) {
		t.Fatal("enrollment readback changed identity or certificate")
	}
}
