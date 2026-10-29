package controlplane

import "errors"

// Preserve the actual response status without exposing response bodies or
// changing the named refusal that existing callers and IPC consumers receive.
type httpRefusal struct {
	status int
	code   string
}

func (failure *httpRefusal) Error() string { return failure.code }

// IsHTTPRefusal distinguishes an authenticated HTTP response from a transport,
// decoder, or same-named local error. A code alone is not non-admission proof.
func IsHTTPRefusal(err error, status int, code string) bool {
	var failure *httpRefusal
	return errors.As(err, &failure) && failure != nil && failure.status == status && failure.code == code
}
