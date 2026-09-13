package protocol

import (
	"errors"
	"fmt"
	"strings"
	"testing"
)

// TestRefusal pins the rule the private channel and the session manager share: a
// refusal code survives the diagnostic wrapped around it, and anything that is
// not a code is refused rather than guessed at.
func TestRefusal(t *testing.T) {
	accepted := map[string]string{
		"a bare code":                    "p2p.direct_unavailable",
		"a wrapped code":                 "p2p.secret_write_failed: value too large",
		"a wrapped Win32 detail":         "p2p.secret_write_failed: Access is denied.",
		"a nested wrapper":               "p2p.runtime_unavailable: dial tcp: refused",
		"dots and underscores":           "p2p.catalog_remove_service",
		"a detail after an empty colon":  "p2p.not_connected:",
		"exactly the longest code":       "p2p." + strings.Repeat("a", MaxRefusalBytes-len("p2p.")),
		"a code with a missing runtime":  "p2p.direct_unavailable",
		"a code whose detail has spaces": "p2p.pair_unauthorized: no pin for this pair",
		"a managed code":                 "managed.missing_registry",
		"a wrapped managed code":         "managed.root_overlap: two roots share a path",
		"a launcher code":                "launcher.update_unavailable",
	}
	for name, message := range accepted {
		t.Run("carries "+name, func(t *testing.T) {
			code, ok := Refusal(errors.New(message))
			if !ok {
				t.Fatalf("Refusal(%q) was refused", message)
			}
			if !strings.HasPrefix(message, code) {
				t.Fatalf("Refusal(%q) = %q, which is not a prefix of it", message, code)
			}
		})
	}

	for name, err := range map[string]error{
		"nothing at all":       nil,
		"an internal sentence": errors.New("password=private-credential"),
		"an empty message":     errors.New(""),
		"a missing prefix":     errors.New("prefix p2p.x"),
		"an uppercase prefix":  errors.New("P2P.direct_unavailable"),
		"no separator at all":  errors.New("p2p."),
		"a code that is too long": errors.New(
			"p2p." + strings.Repeat("a", MaxRefusalBytes-len("p2p.")+1),
		),
		"a space inside the code": errors.New("p2p.direct unavailable"),
		"a newline inside":        errors.New("p2p.direct\nunavailable"),
		"a hyphen inside":         errors.New("p2p.direct-unavailable"),
		"an undeclared family":    errors.New("unknown.operation_failed"),
		"a family without a code": errors.New("managed."),
		"a family alone":          errors.New("managed"),
	} {
		t.Run("refuses "+name, func(t *testing.T) {
			if code, ok := Refusal(err); ok {
				t.Fatalf("Refusal(%v) = %q, want a refusal", err, code)
			}
		})
	}
}

// TestRefusalFindsAWrappedSentinel covers the other way a refusal is wrapped:
// behind the caller's own sentence rather than in front of a detail.
func TestRefusalFindsAWrappedSentinel(t *testing.T) {
	sentinel := errors.New("p2p.secret_write_failed")
	code, ok := Refusal(fmt.Errorf("keychain write failed: %w", sentinel))
	if !ok || code != "p2p.secret_write_failed" {
		t.Fatalf("Refusal = %q, %v", code, ok)
	}
	// The outermost refusal wins, so a code quoted inside a detail cannot
	// reclassify the failure.
	outer := fmt.Errorf("%w: see also p2p.other_code", errors.New("p2p.catalog_write_failed"))
	if code, ok = Refusal(outer); !ok || code != "p2p.catalog_write_failed" {
		t.Fatalf("Refusal = %q, %v", code, ok)
	}
}
