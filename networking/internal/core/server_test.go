package core

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/ankye/dshker/networking/internal/localrpc"
)

func TestHandleAnswersVersion(t *testing.T) {
	result, err := Handle(context.Background(), "core.version", json.RawMessage("{}"))
	if err != nil {
		t.Fatalf("core.version: %v", err)
	}
	version, ok := result.(versionResult)
	if !ok {
		t.Fatalf("core.version returned %T", result)
	}
	if version.Version != Version || version.MethodTableVersion != localrpc.MethodTableVersion {
		t.Fatalf("version result %+v", version)
	}
	if len(version.Methods) != 1 || version.Methods[0] != "core.version" {
		t.Fatalf("method table %v", version.Methods)
	}
	data, err := json.Marshal(version)
	if err != nil {
		t.Fatal(err)
	}
	const expected = "{\"version\":1,\"methodTableVersion\":1,\"methods\":[\"core.version\"]}"
	if string(data) != expected {
		t.Fatalf("version payload %s", data)
	}
}

// A published method this core does not serve yet must be distinguishable from
// a method that does not exist, so the port can proceed method by method.
func TestHandleRefusesUnservedAndUnknownMethods(t *testing.T) {
	cases := map[string]string{
		"devices.list":    "p2p.not_implemented",
		"peer.connect":    "p2p.not_implemented",
		"runtime.connect": "p2p.not_implemented",
		"nope.nope":       "p2p.invalid_operation",
		"":                "p2p.invalid_operation",
	}
	for method, expected := range cases {
		if _, err := Handle(context.Background(), method, json.RawMessage("{}")); err == nil || err.Error() != expected {
			t.Errorf("Handle(%q) = %v, want %s", method, err, expected)
		}
	}
}

func TestHandleEnforcesThePayloadSchema(t *testing.T) {
	cases := map[string]string{
		"{\"extra\":1}":     "p2p.invalid_fields",
		"null":              "p2p.null_field",
		"[]":                "p2p.invalid_fields",
		"":                  "p2p.protocol_limit",
		"{\"a\":1,\"a\":2}": "p2p.duplicate_field",
	}
	for payload, expected := range cases {
		if _, err := Handle(context.Background(), "core.version", json.RawMessage(payload)); err == nil || err.Error() != expected {
			t.Errorf("Handle(core.version, %q) = %v, want %s", payload, err, expected)
		}
	}
}

func TestMethodTableIsPublished(t *testing.T) {
	if len(MethodTable()) == 0 {
		t.Fatal("the core serves no method")
	}
	for _, name := range MethodTable() {
		if _, ok := localrpc.Lookup(name); !ok {
			t.Fatalf("core serves %q, which the published table does not list", name)
		}
	}
}
