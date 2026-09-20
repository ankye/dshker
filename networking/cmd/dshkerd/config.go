package main

// Persisted operator choices for the headless core.
//
// Every headless command needed its full argument list on every run, so routine
// operation meant retyping a checkout path, a pnpm executable, and a service
// identity that never change on a given machine. The file below is the memory
// that removes that: a command records what it was told, and a later run with no
// flags resolves the same values.
//
// Resolution is strictly flag, then persisted value, then documented default. A
// required value with no flag, no record, and no default stays a typed refusal:
// the product's rule is that a missing path or executable fails explicitly
// rather than being inferred, and remembering a value the operator never gave
// would be exactly that inference.

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// ConfigFileName is the operator's persisted choices, beside the endpoint record.
//
// It is deliberately a separate file from `core.json`: that record is the
// endpoint and its secret, rewritten by every `serve` with a fresh token, while
// this one is operator intent that must survive a restart.
const ConfigFileName = "config.json"

// Config is the persisted form. Every field is optional: absent means "never
// supplied", which is what makes a required-value refusal distinguishable from a
// recorded empty choice.
//
// No field holds a password, a session token, or key material. Those belong to
// the OS credential provider, and a plaintext copy here would defeat it.
type Config struct {
	Version int `json:"version"`
	// Directory is the Harness checkout `dsh start` runs.
	Directory string `json:"directory,omitempty"`
	// Pnpm is the pnpm executable or shim that starts it.
	Pnpm string `json:"pnpm,omitempty"`
	// PnpmPrefix are the shim prefix arguments, kept in order.
	PnpmPrefix []string `json:"pnpmPrefix,omitempty"`
	// Patch is an operator-named Cordis overlay, if one was given.
	Patch string `json:"patch,omitempty"`
	// Port is a fixed port; zero means automatic selection.
	Port int `json:"port,omitempty"`
	// Service is the coordinator service identity commands are scoped to.
	Service string `json:"service,omitempty"`
	// Network is the network most recently named for pairing.
	Network string `json:"network,omitempty"`
	// Pair is the paired device most recently connected, so reconnecting to the
	// same peer needs no argument.
	Pair string `json:"pair,omitempty"`
	// DataRoot and CatalogRoot are the `serve` stores.
	DataRoot    string `json:"dataRoot,omitempty"`
	CatalogRoot string `json:"catalogRoot,omitempty"`
	// Roots is the extra CA bundle, if one was given.
	Roots string `json:"roots,omitempty"`
	// Origin, WSS, and STUN are the coordinator endpoints, so refreshing one does
	// not mean retyping the others. PinnedKey is the *path* to the key file, never
	// the key bytes.
	Origin    string `json:"origin,omitempty"`
	WSS       string `json:"wss,omitempty"`
	STUN      string `json:"stun,omitempty"`
	PinnedKey string `json:"pinnedKey,omitempty"`
}

// configPath returns the configuration file inside one state directory.
func configPath(state string) string { return filepath.Join(state, ConfigFileName) }

// LoadConfig reads the persisted choices for one state directory.
//
// A missing file is not a failure: it is a machine that has not been configured
// yet, and every field then resolves from a flag or a default. A file that
// exists but cannot be parsed is a real failure, because silently continuing
// with empty values would discard the operator's recorded intent and could start
// a different checkout than the one they configured.
//
// This decodes with the standard library rather than `protocol.Decode`. That
// decoder is built for wire frames: it rejects unknown fields *and* requires
// every declared field to be present, which is exactly wrong for a record whose
// fields are all optional and omitted when empty. Unknown fields are tolerated
// here on purpose so a file written by a newer build stays readable; the version
// check below is what guards a real format change.
func LoadConfig(state string) (Config, error) {
	data, err := os.ReadFile(configPath(state))
	if err != nil {
		if os.IsNotExist(err) {
			return Config{Version: 1}, nil
		}
		return Config{}, errors.New("p2p.invalid_configuration")
	}
	var config Config
	if json.Unmarshal(data, &config) != nil {
		return Config{}, errors.New("p2p.invalid_configuration")
	}
	if config.Version != 1 {
		return Config{}, errors.New("p2p.invalid_configuration")
	}
	return config, nil
}

// SaveConfig writes the persisted choices, readable only by this user.
//
// Written through a temporary file and renamed, the same way the endpoint record
// is published: an interrupted write must not leave a half-parsed file that the
// next command would reject.
func SaveConfig(state string, config Config) error {
	if state == "" {
		return errors.New("p2p.invalid_configuration")
	}
	config.Version = 1
	if err := os.MkdirAll(state, 0o700); err != nil {
		return errors.New("p2p.insecure_socket_directory")
	}
	encoded, err := json.Marshal(config)
	if err != nil {
		return errors.New("p2p.invalid_configuration")
	}
	path := configPath(state)
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, append(encoded, '\n'), 0o600); err != nil {
		return errors.New("p2p.insecure_socket")
	}
	if err := os.Rename(temporary, path); err != nil {
		_ = os.Remove(temporary)
		return errors.New("p2p.insecure_socket")
	}
	return nil
}

// resolveString returns the effective value and whether it must be written back.
//
// A supplied flag wins and is recorded; otherwise the persisted value is used as
// it is. The boolean is what keeps the file honest: only a real change is
// written, so reading a configured machine does not rewrite its file on every
// command.
func resolveString(flagValue string, stored string) (string, bool) {
	if flagValue != "" && flagValue != stored {
		return flagValue, true
	}
	if flagValue != "" {
		return flagValue, false
	}
	return stored, false
}

// resolveInt applies the same precedence to a numeric value, where zero means
// "not supplied" for both the flag and the record.
func resolveInt(flagValue int, stored int) (int, bool) {
	if flagValue != 0 && flagValue != stored {
		return flagValue, true
	}
	if flagValue != 0 {
		return flagValue, false
	}
	return stored, false
}

// resolveList applies the same precedence to a repeatable flag. An explicitly
// supplied list replaces the record; an empty one reuses it.
func resolveList(flagValue []string, stored []string) ([]string, bool) {
	if len(flagValue) == 0 {
		return stored, false
	}
	if len(flagValue) == len(stored) {
		same := true
		for index := range flagValue {
			if flagValue[index] != stored[index] {
				same = false
				break
			}
		}
		if same {
			return flagValue, false
		}
	}
	return flagValue, true
}

// requireValue turns a still-empty required value into the product's refusal.
func requireValue(value string) error {
	if value == "" {
		return errors.New("p2p.invalid_arguments")
	}
	return nil
}

// runConfig shows or clears the persisted choices.
//
// Persistence that cannot be inspected is a black box: an operator who wonders
// why a command started the wrong checkout needs to see what was remembered, and
// needs one way to forget it.
func runConfig(args []string, stdout io.Writer, stderr io.Writer) int {
	flags := flag.NewFlagSet("config", flag.ContinueOnError)
	flags.SetOutput(stderr)
	state := flags.String("state", "", "per-user state directory")
	clear := flags.Bool("clear", false, "forget every persisted value")
	if flags.Parse(args) != nil {
		return 2
	}
	directory, err := stateRoot(*state)
	if err != nil {
		return fail(stderr, err)
	}
	if *clear {
		if err := os.Remove(configPath(directory)); err != nil && !os.IsNotExist(err) {
			return fail(stderr, errors.New("p2p.invalid_configuration"))
		}
		if _, err := fmt.Fprintln(stdout, "{}"); err != nil {
			return fail(stderr, err)
		}
		return 0
	}
	stored, err := LoadConfig(directory)
	if err != nil {
		return fail(stderr, err)
	}
	encoded, err := json.Marshal(stored)
	if err != nil {
		return fail(stderr, errors.New("p2p.invalid_configuration"))
	}
	if _, err := fmt.Fprintf(stdout, "%s\n", encoded); err != nil {
		return fail(stderr, err)
	}
	return 0
}
