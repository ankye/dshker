package helper

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/ankye/dshker/networking/internal/runtimebridge"
)

// This test-only parent implements the real Main interface. It observes the
// helper boundary; it does not stand in for live peer or DSH acceptance.
type runtimeBindingMain func(context.Context, string, any) (json.RawMessage, error)

func (main runtimeBindingMain) Call(ctx context.Context, method string, payload any) (json.RawMessage, error) {
	return main(ctx, method, payload)
}

func TestRuntimeResumeBindingDispatchKeepsExactScopeAndNeverConnect(t *testing.T) {
	host := New(context.Background())
	t.Cleanup(host.Close)
	want := runtimebridge.Binding{Generation: 9, URL: "http://127.0.0.1:1234/?token=helper-resume-test"}
	for _, scope := range [][2]string{{"aaaaaaaaaaaa", "bbbbbbbbbbbb"}, {"cccccccccccc", "dddddddddddd"}} {
		calls := 0
		host.BindMain(runtimeBindingMain(func(_ context.Context, method string, payload any) (json.RawMessage, error) {
			calls++
			if method != "runtime.resume" {
				t.Fatalf("resume callback substituted another operation: %s", method)
			}
			encoded, err := json.Marshal(payload)
			if err != nil {
				t.Fatal(err)
			}
			var fields map[string]string
			if json.Unmarshal(encoded, &fields) != nil || len(fields) != 2 || fields["serviceId"] != scope[0] || fields["pairId"] != scope[1] {
				t.Fatalf("resume callback changed exact service/pair scope: %s", encoded)
			}
			return json.Marshal(want)
		}))
		binding, err := host.runtimeBinding(context.Background(), "runtime.resume", scope[0], scope[1])
		if err != nil || binding != want || calls != 1 {
			t.Fatalf("resume did not return its owning binding exactly once: binding=%+v calls=%d err=%v", binding, calls, err)
		}
	}
}

func TestRuntimeResumeBindingPreservesTypedOwnerRefusal(t *testing.T) {
	for _, code := range []string{"runtime.worktree_invalid", "p2p.pair_unauthorized", "p2p.runtime_unavailable"} {
		t.Run(code, func(t *testing.T) {
			host := New(context.Background())
			t.Cleanup(host.Close)
			refusal := errors.New(code)
			host.BindMain(runtimeBindingMain(func(_ context.Context, method string, _ any) (json.RawMessage, error) {
				if method != "runtime.resume" {
					t.Fatalf("refused resume fell back to another operation: %s", method)
				}
				return nil, refusal
			}))
			binding, err := host.runtimeBinding(context.Background(), "runtime.resume", "aaaaaaaaaaaa", "bbbbbbbbbbbb")
			if err != refusal || binding != (runtimebridge.Binding{}) {
				t.Fatalf("resume replaced the typed owning refusal or exposed a binding: %v", err)
			}
		})
	}
}

func TestRuntimeResumeBindingRejectsMalformedParentReply(t *testing.T) {
	for name, sample := range map[string][2]string{
		"missing":    {`{"generation":9}`, "p2p.missing_field"},
		"unknown":    {`{"generation":9,"url":"http://127.0.0.1:1234/","extra":true}`, "p2p.invalid_fields"},
		"duplicate":  {`{"generation":9,"generation":10,"url":"http://127.0.0.1:1234/"}`, "p2p.duplicate_field"},
		"null":       {`{"generation":9,"url":null}`, "p2p.null_field"},
		"wrong-type": {`{"generation":"9","url":"http://127.0.0.1:1234/"}`, "p2p.invalid_fields"},
		"trailing":   {`{"generation":9,"url":"http://127.0.0.1:1234/"} {}`, "p2p.invalid_json"},
	} {
		t.Run(name, func(t *testing.T) {
			host := New(context.Background())
			t.Cleanup(host.Close)
			host.BindMain(runtimeBindingMain(func(_ context.Context, method string, _ any) (json.RawMessage, error) {
				if method != "runtime.resume" {
					t.Fatalf("malformed resume reply triggered another operation: %s", method)
				}
				return json.RawMessage(sample[0]), nil
			}))
			if _, err := host.runtimeBinding(context.Background(), "runtime.resume", "aaaaaaaaaaaa", "bbbbbbbbbbbb"); err == nil || err.Error() != sample[1] {
				t.Fatalf("malformed parent binding did not retain its exact admission refusal: %v, want %s", err, sample[1])
			}
		})
	}
}

func TestRuntimeBindingRejectsUnknownDispatchWithoutMainCall(t *testing.T) {
	host := New(context.Background())
	t.Cleanup(host.Close)
	calls := 0
	host.BindMain(runtimeBindingMain(func(context.Context, string, any) (json.RawMessage, error) {
		calls++
		return nil, nil
	}))
	if _, err := host.runtimeBinding(context.Background(), "runtime.restart", "aaaaaaaaaaaa", "bbbbbbbbbbbb"); err == nil || err.Error() != "p2p.invalid_operation" || calls != 0 {
		t.Fatalf("unknown binding dispatch reached main or lost its typed refusal: calls=%d err=%v", calls, err)
	}
}
