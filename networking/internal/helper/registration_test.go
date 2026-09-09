package helper

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/protocol"
)

func registrationAccount(t *testing.T, handler http.Handler) *account {
	t.Helper()
	server := httptest.NewTLSServer(handler)
	t.Cleanup(server.Close)
	roots := x509.NewCertPool()
	roots.AddCert(server.Certificate())
	client, err := controlplane.New(controlplane.Endpoints{
		HTTPSOrigin: server.URL,
		WSSURL:      strings.Replace(server.URL, "https:", "wss:", 1) + "/v1/signals",
		STUNAddress: "127.0.0.1:3478",
	}, roots)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(client.Close)
	return &account{base: client}
}

// user.register must hand back a usable session: the coordinator's register
// endpoint returns the user only, so the helper signs in with the same
// credentials rather than reporting a session it never received.
func TestUserRegisterSignsInAfterCreatingTheAccount(t *testing.T) {
	userID := protocol.NewID()
	var calls []string
	account := registrationAccount(t, http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		calls = append(calls, request.URL.Path)
		writer.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/v1/register":
			var body struct {
				Email    string `json:"email"`
				Password string `json:"password"`
			}
			if json.NewDecoder(request.Body).Decode(&body) != nil || body.Email != "alice@example.com" || body.Password != "a-long-password" {
				t.Fatalf("registration credentials altered: %+v", body)
			}
			_ = json.NewEncoder(writer).Encode(controlplane.User{UserID: userID, Username: "alice@example.com"})
		case "/v1/login":
			var body struct {
				Username string `json:"username"`
				Password string `json:"password"`
			}
			if json.NewDecoder(request.Body).Decode(&body) != nil || body.Username != "alice@example.com" || body.Password != "a-long-password" {
				t.Fatalf("sign-in did not reuse the registered credentials: %+v", body)
			}
			_ = json.NewEncoder(writer).Encode(controlplane.UserSession{
				User:      controlplane.User{UserID: userID, Username: "alice@example.com"},
				Token:     strings.Repeat("a", 64),
				ExpiresAt: time.Now().Add(time.Hour).Unix(),
			})
		default:
			t.Fatalf("unexpected call: %s", request.URL.Path)
		}
	}))
	result, err := account.management(context.Background(), "user.register", json.RawMessage(`{"email":"alice@example.com","password":"a-long-password"}`))
	if err != nil {
		t.Fatal(err)
	}
	session, ok := result.(controlplane.UserSession)
	if !ok || session.User.UserID != userID || len(session.Token) != 64 {
		t.Fatalf("register did not return a usable session: %+v", result)
	}
	if len(calls) != 2 || calls[0] != "/v1/register" || calls[1] != "/v1/login" {
		t.Fatalf("expected register then login, got %v", calls)
	}
}

// A refused registration must not be followed by a sign-in attempt, and the
// coordinator's reason must survive unchanged.
func TestUserRegisterReportsRefusalWithoutSigningIn(t *testing.T) {
	var calls []string
	account := registrationAccount(t, http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		calls = append(calls, request.URL.Path)
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusConflict)
		// The coordinator reports refusals as {"code": "p2p...."}.
		_ = json.NewEncoder(writer).Encode(map[string]string{"code": "p2p.user_conflict"})
	}))
	_, err := account.management(context.Background(), "user.register", json.RawMessage(`{"email":"taken@example.com","password":"a-long-password"}`))
	if err == nil || !strings.Contains(err.Error(), "p2p.user_conflict") {
		t.Fatalf("duplicate email refusal not surfaced: %v", err)
	}
	if len(calls) != 1 || calls[0] != "/v1/register" {
		t.Fatalf("a refused registration must not attempt a sign-in, got %v", calls)
	}
}

func TestUserRegisterRejectsMalformedRequest(t *testing.T) {
	account := registrationAccount(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("a malformed request must never reach the coordinator")
	}))
	if _, err := account.management(context.Background(), "user.register", json.RawMessage(`{"email":5}`)); err == nil {
		t.Fatal("accepted a malformed registration request")
	}
}
