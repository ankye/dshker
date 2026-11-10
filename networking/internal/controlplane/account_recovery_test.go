package controlplane

import (
	"strings"
	"testing"
)

func TestPasswordResetUnicodeAndSecretAdmission(t *testing.T) {
	for _, test := range []struct {
		name, email, code, password string
		valid                       bool
	}{
		{"twelve-unicode-runes", "account@example.test", strings.Repeat("a", 64), strings.Repeat("新", 12), true},
		{"astral-code-points", "account@example.test", strings.Repeat("a", 64), strings.Repeat("😀", 12), true},
		{"short-runes", "account@example.test", strings.Repeat("a", 64), strings.Repeat("😀", 6), false},
		{"over-bcrypt-byte-limit", "account@example.test", strings.Repeat("a", 64), strings.Repeat("新", 25), false},
		{"noncanonical-code", "account@example.test", strings.Repeat("A", 64), strings.Repeat("新", 12), false},
		{"non-email", "account", strings.Repeat("a", 64), strings.Repeat("新", 12), false},
	} {
		t.Run(test.name, func(t *testing.T) {
			if ValidPasswordReset(test.email, test.code, test.password) != test.valid {
				t.Fatal("password recovery admission disagrees with Unicode/code contract")
			}
		})
	}
}
