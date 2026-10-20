package integration

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
)

func TestRealDSHReadinessDiagnosticNeverEmitsCredentials(t *testing.T) {
	const token = "pure_test_secret_do_not_emit"
	const endpoint = "http://127.0.0.1:43123/?token=" + token
	for _, test := range []struct {
		name, endpoint, code, cause, port string
		err                               error
	}{
		{"http", endpoint, "p2p.runtime_http_failed", "http", "43123", fmt.Errorf("%w: %s", errors.New("p2p.runtime_http_failed"), endpoint)},
		{"websocket", endpoint, "p2p.runtime_websocket_failed", "websocket", "43123", fmt.Errorf("%w: %s", errors.New("p2p.runtime_websocket_failed"), endpoint)},
		{"redirect", endpoint, "p2p.redirect_rejected", "redirect", "43123", fmt.Errorf("%w: %s", errors.New("p2p.redirect_rejected"), endpoint)},
		{"invalid", "http://127.0.0.1:invalid/?token=" + token, "p2p.runtime_invalid", "endpoint", "invalid", errors.New("p2p.runtime_invalid")},
		{"deadline", endpoint, "test.dsh_readiness_deadline", "deadline", "43123", fmt.Errorf("%s: %w", endpoint, context.DeadlineExceeded)},
		{"cancelled", endpoint, "test.dsh_readiness_cancelled", "cancelled", "43123", fmt.Errorf("%s: %w", endpoint, context.Canceled)},
		{"untyped", endpoint, "test.dsh_readiness_untyped_failure", "untyped", "43123", errors.New(strings.Repeat(endpoint, 100))},
		{"untrusted-code", endpoint, "test.dsh_readiness_untyped_failure", "untyped", "43123", errors.New("p2p." + token)},
		{"missing-error", endpoint, "test.dsh_readiness_error_missing", "missing", "43123", nil},
		{"foreign-host", "http://" + token + ":43123/", "p2p.runtime_invalid", "endpoint", "invalid", errors.New("p2p.runtime_invalid")},
		{"userinfo", "http://" + token + "@127.0.0.1:43123/", "p2p.runtime_invalid", "endpoint", "invalid", errors.New("p2p.runtime_invalid")},
		{"invalid-port", "http://127.0.0.1:99999/?token=" + token, "p2p.runtime_invalid", "endpoint", "invalid", errors.New("p2p.runtime_invalid")},
	} {
		t.Run(test.name, func(t *testing.T) {
			message := realDSHReadinessDiagnostic(test.endpoint, test.err)
			if strings.Contains(message, token) || strings.Contains(message, test.endpoint) || strings.Contains(message, "http://") || strings.Contains(message, "token=") {
				t.Fatal("readiness diagnostic exposed credential-bearing input")
			}
			want := fmt.Sprintf("real DSH did not become ready port=%s code=%s cause=%s", test.port, test.code, test.cause)
			if message != want {
				t.Fatal("readiness diagnostic lost its exact safe port/code/cause classification")
			}
			if len(message) > 160 {
				t.Fatal("readiness diagnostic was not bounded")
			}
		})
	}
}

func TestRealDSHReadinessDiagnosticDistinguishesRuntimePorts(t *testing.T) {
	first := realDSHReadinessDiagnostic("http://127.0.0.1:43123/?token=pure_test_first", errors.New("p2p.runtime_http_failed"))
	second := realDSHReadinessDiagnostic("http://127.0.0.1:43124/?token=pure_test_second", errors.New("p2p.runtime_http_failed"))
	if !strings.Contains(first, "port=43123 ") || !strings.Contains(second, "port=43124 ") || first == second {
		t.Fatal("readiness diagnostic aliased separately owned runtime ports")
	}
}
