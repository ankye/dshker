// Package protocol owns the versioned, fail-closed peer wire contract.
package protocol

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"reflect"
)

const Version = 1
const MaxControlBytes = 64 * 1024

// MaxCapabilities bounds an advertised capability list so a peer cannot use it as
// an unbounded channel.
const MaxCapabilities = 32

// CapabilityOptionalWorkbench says this peer keeps a connection established when
// no workbench can be started on either side.
const CapabilityOptionalWorkbench = "workbench.optional"

// PeerCapabilities is what this build advertises during a peer handshake.
//
// The list is the extension point for the peer contract, and it is deliberately a
// list rather than a new field per feature: a later build adds a name here and
// peers that do not know it ignore it, so this structure never has to change
// again. Never reuse or repurpose a name — a name means exactly one behaviour
// forever, because the peer deciding what to do with it may be any older build.
func PeerCapabilities() []string {
	// A fresh slice per call: a caller must not be able to alter what this build
	// claims. Never nil, because an omitted or null field is refused on the wire.
	return []string{CapabilityOptionalWorkbench}
}

// HasCapability reports whether an advertised list contains one name.
func HasCapability(advertised []string, name string) bool {
	for _, value := range advertised {
		if value == name {
			return true
		}
	}
	return false
}

// ValidCapabilities reports whether an advertised list is well formed. A peer may
// advertise names this build does not know; it may not advertise a flood of them,
// blank ones, or duplicates that make the list ambiguous.
func ValidCapabilities(advertised []string) bool {
	if len(advertised) > MaxCapabilities {
		return false
	}
	seen := make(map[string]bool, len(advertised))
	for _, value := range advertised {
		if value == "" || len(value) > 64 || seen[value] {
			return false
		}
		seen[value] = true
	}
	return true
}

// Decode rejects duplicate keys, oversized input, trailing values and missing
// fields, and ignores fields it does not know.
//
// Duplicate-key rejection matters because signatures must have one interpretation.
// Every field the target declares must still be present: a peer must never be able
// to omit one and have it read as a zero value.
//
// Unknown fields are ignored rather than refused, which is what lets this wire
// contract ever grow again. Refusing them made every message permanently frozen:
// adding one optional field to a handshake would have been rejected outright by
// every peer built before it, so two computers running adjacent builds could not
// talk at all. That is not a theoretical cost — it is why a fix shipped to one
// machine could not take effect until the other was upgraded too, with each side's
// log blaming something different.
//
// This does not weaken the signed messages. A Signal's signature covers an
// explicit, fixed-order list of named fields (see SigningBytes), never the raw
// JSON, so a field nobody declares is outside the signature already and cannot be
// smuggled into one. An ignored field also reaches no Go value: it is dropped
// here, so no later code can act on it.
func Decode(data []byte, target any) error {
	if len(data) == 0 || len(data) > MaxControlBytes {
		return errors.New("p2p.protocol_limit")
	}
	reader := json.NewDecoder(bytes.NewReader(data))
	if err := uniqueValue(reader, 0); err != nil {
		return err
	}
	if _, err := reader.Token(); err != io.EOF {
		return errors.New("p2p.invalid_json")
	}
	reader = json.NewDecoder(bytes.NewReader(data))
	if err := reader.Decode(target); err != nil {
		return errors.New("p2p.invalid_fields")
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(data, &fields) != nil || fields == nil {
		return errors.New("p2p.invalid_fields")
	}
	typeInfo := reflect.TypeOf(target).Elem()
	for index := 0; index < typeInfo.NumField(); index++ {
		name := typeInfo.Field(index).Tag.Get("json")
		if _, exists := fields[name]; !exists {
			return errors.New("p2p.missing_field")
		}
	}
	return nil
}

// DecodeExact is Decode plus refusal of any field the target does not declare.
//
// Used where both ends of a message are controlled together — this process's own
// private channel, and the coordinator API this client is written against. There
// an unrecognized field means the contract drifted, and finding that immediately is
// worth more than tolerating it. The peer contract is the opposite case and uses
// Decode: there the two ends are separate machines on separate release schedules,
// and refusing an unknown field freezes the protocol forever.
func DecodeExact(data []byte, target any) error {
	if err := Decode(data, target); err != nil {
		return err
	}
	reader := json.NewDecoder(bytes.NewReader(data))
	reader.DisallowUnknownFields()
	if err := reader.Decode(target); err != nil {
		return errors.New("p2p.invalid_fields")
	}
	return nil
}

func uniqueValue(reader *json.Decoder, depth int) error {
	if depth > 12 {
		return errors.New("p2p.protocol_limit")
	}
	token, err := reader.Token()
	if err != nil {
		return errors.New("p2p.invalid_json")
	}
	delim, container := token.(json.Delim)
	if !container {
		if token == nil {
			return errors.New("p2p.null_field")
		}
		return nil
	}
	keys := make(map[string]bool)
	for reader.More() {
		if delim == '{' {
			key, err := reader.Token()
			if err != nil {
				return errors.New("p2p.invalid_json")
			}
			name, valid := key.(string)
			if !valid || keys[name] {
				return errors.New("p2p.duplicate_field")
			}
			keys[name] = true
		}
		if err := uniqueValue(reader, depth+1); err != nil {
			return err
		}
	}
	_, err = reader.Token()
	return err
}
