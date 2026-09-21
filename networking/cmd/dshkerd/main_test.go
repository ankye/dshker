package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/ankye/dshker/networking/internal/secret"
)

// Every argument is optional and, when given, must be an absolute path. The
// shell passes the two roots; a typo must fail the boot rather than start a core
// with the wrong state.
func TestParseArgumentsAcceptsAbsoluteRoots(t *testing.T) {
	data := filepath.Join(t.TempDir(), "data")
	catalogRoot := filepath.Join(t.TempDir(), "catalog")
	state := filepath.Join(t.TempDir(), "state")
	roots := filepath.Join(t.TempDir(), "ca.pem")
	cases := []struct {
		name string
		args []string
		want options
	}{
		{"no arguments", nil, options{}},
		{"data only", []string{"--data", data}, options{dataRoot: data}},
		{"catalog only", []string{"--catalog", catalogRoot}, options{catalogRoot: catalogRoot}},
		{"state only", []string{"--state", state}, options{stateRoot: state}},
		{"both", []string{"--data", data, "--catalog", catalogRoot}, options{dataRoot: data, catalogRoot: catalogRoot}},
		{"both in the other order", []string{"--catalog", catalogRoot, "--data", data}, options{dataRoot: data, catalogRoot: catalogRoot}},
		{"all three", []string{"--roots", roots, "--catalog", catalogRoot, "--data", data}, options{dataRoot: data, catalogRoot: catalogRoot, rootsPath: roots}},
		{"desktop autostart roots", []string{"--state", state, "--roots", roots, "--catalog", catalogRoot, "--data", data}, options{stateRoot: state, dataRoot: data, catalogRoot: catalogRoot, rootsPath: roots}},
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
		"a repeated --state":      {"--state", absolute, "--state", absolute},
		"a relative --state":      {"--state", "relative/path"},
		"a repeated --catalog":    {"--catalog", absolute, "--catalog", absolute},
		"a repeated --roots":      {"--roots", absolute, "--roots", absolute},
		"a relative --roots":      {"--roots", "ca.pem"},
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

func TestClearStaleEndpointRecordRejectsUnexpectedFiles(t *testing.T) {
	state := t.TempDir()
	record := filepath.Join(state, "core.json")
	if err := clearStaleEndpointRecord(state); err != nil {
		t.Fatalf("absent record: %v", err)
	}
	if err := os.WriteFile(record, []byte("stale"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := clearStaleEndpointRecord(state); err != nil {
		t.Fatalf("stale regular record: %v", err)
	}
	if _, err := os.Lstat(record); !os.IsNotExist(err) {
		t.Fatalf("stale record remains: %v", err)
	}
	if runtime.GOOS == "windows" {
		return // Creating a symlink requires extra privileges on Windows.
	}
	target := filepath.Join(state, "untouched")
	if err := os.WriteFile(target, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, record); err != nil {
		t.Fatal(err)
	}
	if err := clearStaleEndpointRecord(state); err == nil || err.Error() != "p2p.insecure_socket" {
		t.Fatalf("symlink was not refused: %v", err)
	}
	if data, err := os.ReadFile(target); err != nil || string(data) != "keep" {
		t.Fatalf("symlink target changed: %s, %v", data, err)
	}
}

// TestSecretStoreForToleratesOnlyAnAbsentProvider pins the rule: a host without a
// platform provider still runs a core, while a broken provider is fatal.
func TestSecretStoreForToleratesOnlyAnAbsentProvider(t *testing.T) {
	store, err := secretStoreFor(func(string) (secret.Store, error) {
		return nil, secret.ErrUnavailable
	}, "/data")
	if err != nil || store != nil {
		t.Fatalf("an absent provider = %v, %v", store, err)
	}
	wrapped, err := secretStoreFor(func(string) (secret.Store, error) {
		return nil, fmt.Errorf("open %w", secret.ErrUnavailable)
	}, "/data")
	if err != nil || wrapped != nil {
		t.Fatalf("a wrapped absent provider = %v, %v", wrapped, err)
	}
	broken := errors.New("p2p.secret_read_failed")
	if _, err := secretStoreFor(func(string) (secret.Store, error) {
		return nil, broken
	}, "/data"); !errors.Is(err, broken) {
		t.Fatalf("a broken provider = %v", err)
	}
}
