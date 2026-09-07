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

// Decode rejects duplicate keys, unknown fields, oversized input and trailing values.
// Duplicate-key rejection matters because signatures must have one interpretation.
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
	reader.DisallowUnknownFields()
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
