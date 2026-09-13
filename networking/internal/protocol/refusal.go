package protocol

import (
	"errors"
	"strings"
)

// MaxRefusalBytes is the longest public refusal code. The private channel's
// error field carries exactly one such code, never a sentence.
const MaxRefusalBytes = 96

// Refusal reports the public refusal code an error carries.
//
// A code is either the whole message ("p2p.direct_unavailable") or the prefix of
// a wrapped one ("p2p.secret_write_failed: value too large"), because the
// packages keep their diagnostics by wrapping a sentinel with
// fmt.Errorf("%w: ..."). The detail is deliberately dropped on the way out: the
// shell can act on the classification but not on a Win32 or Keychain sentence,
// and collapsing the whole message to p2p.operation_failed — which is what a
// stricter check did — hid which class of failure it was.
//
// The rule is one place on purpose. The private channel and the session manager
// both need it, and when they each spelled it out they disagreed: the channel
// rejected anything with a colon while the manager rejected anything with a
// space, so the same wrapped sentinel was classified differently depending on
// which layer reported it.
func Refusal(err error) (string, bool) {
	// The whole chain is consulted, outermost first, because a caller may wrap a
	// sentinel behind its own sentence ("keychain write failed: %w") as well as
	// in front of a detail. An unrelated code mentioned inside a detail never
	// wins, since a match is anchored at the start of a message.
	for current := err; current != nil; current = errors.Unwrap(current) {
		if code, ok := refusalPrefix(current.Error()); ok {
			return code, true
		}
	}
	return "", false
}

// refusalPrefix reports whether one message is, or begins with, a public code.
func refusalPrefix(message string) (string, bool) {
	value := message
	if index := strings.IndexByte(value, ':'); index >= 0 {
		value = value[:index]
	}
	if len(value) < len("p2p.")+1 || len(value) > MaxRefusalBytes || !strings.HasPrefix(value, "p2p.") {
		return "", false
	}
	for _, c := range value[len("p2p."):] {
		if (c < 'a' || c > 'z') && c != '_' && c != '.' {
			return "", false
		}
	}
	return value, true
}
