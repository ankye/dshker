package controlplane

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"testing"
)

func TestHTTPRefusalPreservesActualStatusAndUnchangedNamedCode(t *testing.T) {
	for _, test := range []struct {
		name   string
		status int
		code   string
	}{
		{"rate_limit", http.StatusTooManyRequests, "p2p.rate_limited"},
		{"same_rate_code_503", http.StatusServiceUnavailable, "p2p.rate_limited"},
		{"absent_attempt", http.StatusNotFound, "p2p.attempt_not_found"},
		{"same_absence_code_503", http.StatusServiceUnavailable, "p2p.attempt_not_found"},
	} {
		t.Run(test.name, func(t *testing.T) {
			client := testClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/v2/candidates/prepare" || r.Method != http.MethodPost {
					t.Error("HTTP refusal changed its real dispatch")
				}
				w.WriteHeader(test.status)
				json.NewEncoder(w).Encode(map[string]string{"code": test.code})
			}))
			_, err := client.response(context.Background(), http.MethodPost, "/v2/candidates/prepare", "", nil)
			if err == nil || err.Error() != test.code || !IsHTTPRefusal(err, test.status, test.code) || !IsHTTPRefusal(fmt.Errorf("wrapped: %w", err), test.status, test.code) {
				t.Fatal("HTTP status or the original named refusal was lost", err)
			}
			if IsHTTPRefusal(err, http.StatusOK, test.code) || IsHTTPRefusal(err, test.status, "p2p.invalid_request") || IsHTTPRefusal(errors.New(test.code), test.status, test.code) {
				t.Fatal("unproven local code was promoted to an authoritative HTTP refusal")
			}
		})
	}
	if IsHTTPRefusal(nil, http.StatusNotFound, "p2p.attempt_not_found") {
		t.Fatal("missing response proved non-admission")
	}
}

func TestHTTPRefusalDoesNotAuthorizeMalformedOrSuccessfulErrorBodies(t *testing.T) {
	for _, status := range []int{http.StatusOK, http.StatusTooManyRequests} {
		client := testClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(status)
			w.Write([]byte(`{"code":"p2p.rate_limited","unknown":"ignored"}`))
		}))
		_, err := client.response(context.Background(), http.MethodPost, "/v2/candidates/prepare", "", nil)
		if IsHTTPRefusal(err, http.StatusTooManyRequests, "p2p.rate_limited") {
			t.Fatal("malformed or success response became a proven middleware refusal", status, err)
		}
	}
}
