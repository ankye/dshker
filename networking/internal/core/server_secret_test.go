package core

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"strings"
	"sync"
	"testing"

	"github.com/ankye/dshker/networking/internal/secret"
)

// memoryStore is the in-memory secret.Store the unit tests drive. The real
// providers are exercised end to end by the integration suite and by the
// internal/secret round-trip tests on their own platforms.
type memoryStore struct {
	mu   sync.Mutex
	keys map[string][]byte
}

func newMemoryStore() *memoryStore { return &memoryStore{keys: make(map[string][]byte)} }

func (store *memoryStore) Get(key string) ([]byte, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	value, ok := store.keys[key]
	if !ok {
		return nil, secret.ErrMissing
	}
	return value, nil
}

func (store *memoryStore) Set(key string, value []byte) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.keys[key] = value
	return nil
}

func (store *memoryStore) Delete(key string) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	delete(store.keys, key)
	return nil
}

func TestServeSecretRoundTrip(t *testing.T) {
	server := Serve{Store: newMemoryStore()}
	key := "dshker.peer.credential." + strings.Repeat("a", 64)
	plaintext := []byte(`{"serviceId":"x"}`)

	if _, err := server.Handle(context.Background(), "core.secret_set", json.RawMessage(`{"key":"`+key+`","value":"`+base64.StdEncoding.EncodeToString(plaintext)+`"}`)); err != nil {
		t.Fatalf("set: %v", err)
	}

	result, err := server.Handle(context.Background(), "core.secret_get", json.RawMessage(`{"key":"`+key+`"}`))
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	response, ok := result.(struct {
		Value string `json:"value"`
	})
	if !ok {
		t.Fatalf("get returned %T", result)
	}
	got, err := base64.StdEncoding.DecodeString(response.Value)
	if err != nil || string(got) != string(plaintext) {
		t.Fatalf("round trip changed the value: %q (%v)", got, err)
	}

	if _, err := server.Handle(context.Background(), "core.secret_delete", json.RawMessage(`{"key":"`+key+`"}`)); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := server.Handle(context.Background(), "core.secret_get", json.RawMessage(`{"key":"`+key+`"}`)); err == nil || err.Error() != "p2p.secret_missing" {
		t.Fatalf("get after delete = %v", err)
	}
}

func TestServeSecretMethodsRefuseWithoutAProvider(t *testing.T) {
	server := Serve{}
	key := strings.Repeat("a", 64)
	payloads := map[string]string{
		"core.secret_get":    `{"key":"` + key + `"}`,
		"core.secret_set":    `{"key":"` + key + `","value":"` + base64.StdEncoding.EncodeToString([]byte("x")) + `"}`,
		"core.secret_delete": `{"key":"` + key + `"}`,
	}
	for method, payload := range payloads {
		if _, err := server.Handle(context.Background(), method, json.RawMessage(payload)); err == nil || err.Error() != "p2p.secret_provider_unavailable" {
			t.Errorf("%s without a store = %v", method, err)
		}
	}
}

func TestServeSecretMethodsRefuseMalformedPayloads(t *testing.T) {
	server := Serve{Store: newMemoryStore()}
	key := strings.Repeat("a", 64)
	cases := map[string]string{
		// A key and a value are both required; protocol.Decode requires every field.
		`{"key":"` + key + `"}`: "p2p.missing_field",
		`{"value":"` + base64.StdEncoding.EncodeToString([]byte("x")) + `"}`:          "p2p.missing_field",
		`{"key":"` + key + `","value":"not-base64!"}`:                                 "p2p.invalid_payload",
		`{"key":"","value":"` + base64.StdEncoding.EncodeToString([]byte("x")) + `"}`: "p2p.invalid_payload",
	}
	for payload, expected := range cases {
		if _, err := server.Handle(context.Background(), "core.secret_set", json.RawMessage(payload)); err == nil || err.Error() != expected {
			t.Errorf("set(%s) = %v, want %s", payload, err, expected)
		}
	}
}

func TestServeSecretMethodsArePublished(t *testing.T) {
	for _, name := range []string{"core.secret_get", "core.secret_set", "core.secret_delete"} {
		found := false
		for _, served := range MethodTable() {
			if served == name {
				found = true
			}
		}
		if !found {
			t.Errorf("%s is not listed by MethodTable", name)
		}
	}
}
