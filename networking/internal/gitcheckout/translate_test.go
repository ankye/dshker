package gitcheckout

import (
	"errors"
	"fmt"
	"testing"
)

// TestRendererCodeTranslatesTheThreeCodes pins the boundary rule: the renderer
// sees exactly the codes it already maps, and an internal git.* code never
// reaches it.
func TestRendererCodeTranslatesTheThreeCodes(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want string
	}{
		{name: "remote input", err: ErrRemoteInvalid, want: CodeRemoteInvalid},
		{name: "wrapped remote input", err: fmt.Errorf("%w: bad host", ErrRemoteInvalid), want: CodeRemoteInvalid},
		{name: "revision input", err: ErrRevisionInvalid, want: CodeRevisionInvalid},
		{name: "a commit that moved", err: ErrRefNotCommit, want: CodeOperationFailed},
		{name: "a rewritten reference", err: ErrRefRewritten, want: CodeOperationFailed},
		{name: "an observed mismatch", err: ErrRemoteMismatch, want: CodeOperationFailed},
		{name: "something else", err: errors.New("boom"), want: CodeOperationFailed},
		{name: "no failure", err: nil, want: ""},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := RendererCode(testCase.err); got != testCase.want {
				t.Fatalf("RendererCode(%v) = %q, want %q", testCase.err, got, testCase.want)
			}
		})
	}
}
