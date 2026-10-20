//go:build live

package integration

import (
	"encoding/hex"
	"errors"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/protocol"
)

// Only initial isolated setup imports a real issued session. Neither crash
// recovery nor idle readback may fabricate or re-import one to hide failed restore.
func recoveryValidateInitialSession(session controlplane.UserSession, resourceDeadline int64) error {
	token, err := hex.DecodeString(session.Token)
	if err != nil || len(token) != 32 || !protocol.ValidID(session.User.UserID) || session.User.Username == "" ||
		resourceDeadline <= time.Now().Unix() || session.ExpiresAt < resourceDeadline {
		return errors.New("test.initial_session_missing_or_too_short")
	}
	return nil
}

func TestRecoveryInitialSessionRequiresRealScopeAndFullScenarioLifetime(t *testing.T) {
	deadline := time.Now().Add(9 * time.Hour).Unix()
	valid := controlplane.UserSession{User: controlplane.User{UserID: "aaaaaaaaaaaa", Username: "test-only@example.test"}, Token: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", ExpiresAt: deadline}
	if err := recoveryValidateInitialSession(valid, deadline); err != nil {
		t.Fatal(err)
	}
	for _, mutate := range []func(*controlplane.UserSession){
		func(value *controlplane.UserSession) { value.Token = "" },
		func(value *controlplane.UserSession) { value.Token = "not-a-session" },
		func(value *controlplane.UserSession) { value.User.UserID = "" },
		func(value *controlplane.UserSession) { value.User.Username = "" },
		func(value *controlplane.UserSession) { value.ExpiresAt = deadline - 1 },
	} {
		invalid := valid
		mutate(&invalid)
		if err := recoveryValidateInitialSession(invalid, deadline); err == nil {
			t.Fatal("missing or short initial session was admitted for long physical proof")
		}
	}
}
