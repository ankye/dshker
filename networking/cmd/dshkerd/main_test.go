package main

import (
	"path/filepath"
	"testing"
)

// Both roots are optional and, when given, must be absolute directories. The
// shell passes them; a typo must fail the boot rather than start a core with
// the wrong state.
func TestParseArgumentsAcceptsAbsoluteRoots(t *testing.T) {
	data := filepath.Join(t.TempDir(), "data")
	catalogRoot := filepath.Join(t.TempDir(), "catalog")
	cases := []struct {
		name string
		args []string
		want options
	}{
		{"no arguments", nil, options{}},
		{"data only", []string{"--data", data}, options{dataRoot: data}},
		{"catalog only", []string{"--catalog", catalogRoot}, options{catalogRoot: catalogRoot}},
		{"both", []string{"--data", data, "--catalog", catalogRoot}, options{dataRoot: data, catalogRoot: catalogRoot}},
		{"both in the other order", []string{"--catalog", catalogRoot, "--data", data}, options{dataRoot: data, catalogRoot: catalogRoot}},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			parsed, err := parseArguments(testCase.args)
			if err != nil {
				t.Fatalf("parse: %v", err)
			}
			if parsed != testCase.want {
				t.Fatalf("parsed %+v, want %+v", parsed, testCase.want)
			}
		})
	}
}

func TestParseArgumentsRefusesMalformedCommands(t *testing.T) {
	absolute := filepath.Join(t.TempDir(), "root")
	for name, args := range map[string][]string{
		"a flag without a value":  {"--data"},
		"an empty value":          {"--data", ""},
		"a relative value":        {"--data", "relative/path"},
		"an unknown flag":         {"--other", absolute},
		"a repeated --data":       {"--data", absolute, "--data", absolute},
		"a repeated --catalog":    {"--catalog", absolute, "--catalog", absolute},
		"a trailing flag":         {"--data", absolute, "--catalog"},
		"a bare positional value": {absolute, absolute},
		"a value before its flag": {absolute, "--data"},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := parseArguments(args); err == nil {
				t.Fatalf("%v was accepted", args)
			}
		})
	}
}
