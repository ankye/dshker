package rootregistry

import (
	"bytes"
	"encoding/json"
)

// Parse strictly decodes one persisted registry.
//
// Every key the format defines must be present and nothing else may be, which is
// what the shell's requireExactKeys enforced: a record with a missing or unknown
// field is a different document, not one to guess at.
func Parse(raw []byte, nativeDshHome string) (Registry, error) {
	if len(raw) == 0 || len(raw) > MaxRegistryBytes {
		return Registry{}, ErrInvalid
	}
	fields, err := decodeObject(raw)
	if err != nil {
		return Registry{}, ErrInvalid
	}
	if !exactKeys(fields, "format", "version", "roots", "workspaces") {
		return Registry{}, ErrInvalid
	}
	var format string
	if json.Unmarshal(fields["format"], &format) != nil || format != Format {
		return Registry{}, ErrInvalid
	}
	var version int
	if json.Unmarshal(fields["version"], &version) != nil {
		return Registry{}, ErrInvalid
	}
	if version != Version {
		return Registry{}, ErrUnsupportedVersion
	}
	roots, err := parseRoots(fields["roots"])
	if err != nil {
		return Registry{}, err
	}
	workspaces, err := parseWorkspaces(fields["workspaces"])
	if err != nil {
		return Registry{}, err
	}
	registry := Registry{Format: Format, Version: Version, Roots: roots, Workspaces: workspaces}
	if err := AssertRootLayout(registry.Roots, nativeDshHome); err != nil {
		return Registry{}, err
	}
	for _, workspace := range registry.Workspaces {
		if err := AssertWorkspaceBinding(workspace, registry.Roots, nativeDshHome); err != nil {
			return Registry{}, err
		}
	}
	if err := AssertWorkspacesDoNotOverlap(registry.Workspaces); err != nil {
		return Registry{}, err
	}
	return registry, nil
}

func parseRoots(raw json.RawMessage) ([]Root, error) {
	var entries []json.RawMessage
	if json.Unmarshal(raw, &entries) != nil || entries == nil {
		return nil, ErrInvalid
	}
	roots := make([]Root, 0, len(entries))
	for _, entry := range entries {
		fields, err := decodeObject(entry)
		if err != nil {
			return nil, ErrInvalid
		}
		if !exactKeys(fields, "rootId", "kind", "canonicalPath") {
			return nil, ErrInvalid
		}
		var root Root
		if json.Unmarshal(fields["rootId"], &root.RootID) != nil ||
			json.Unmarshal(fields["kind"], &root.Kind) != nil ||
			json.Unmarshal(fields["canonicalPath"], &root.CanonicalPath) != nil {
			return nil, ErrInvalid
		}
		if err := AssertOpaqueID(root.RootID); err != nil {
			return nil, err
		}
		if !IsKind(root.Kind) {
			return nil, ErrInvalid
		}
		roots = append(roots, root)
	}
	return roots, nil
}

func parseWorkspaces(raw json.RawMessage) ([]Workspace, error) {
	var entries []json.RawMessage
	if json.Unmarshal(raw, &entries) != nil || entries == nil {
		return nil, ErrInvalid
	}
	workspaces := make([]Workspace, 0, len(entries))
	for _, entry := range entries {
		fields, err := decodeObject(entry)
		if err != nil {
			return nil, ErrInvalid
		}
		if !exactKeys(fields, "workspaceId", "displayName", "workingDirectoryCapabilityId", "workingDirectoryCanonicalPath", "rootNamespaces") {
			return nil, ErrInvalid
		}
		var workspace Workspace
		if json.Unmarshal(fields["workspaceId"], &workspace.WorkspaceID) != nil ||
			json.Unmarshal(fields["displayName"], &workspace.DisplayName) != nil ||
			json.Unmarshal(fields["workingDirectoryCapabilityId"], &workspace.WorkingDirectoryCapabilityID) != nil ||
			json.Unmarshal(fields["workingDirectoryCanonicalPath"], &workspace.WorkingDirectoryCanonicalPath) != nil {
			return nil, ErrInvalid
		}
		if err := AssertOpaqueID(workspace.WorkspaceID); err != nil {
			return nil, err
		}
		if err := AssertWorkspaceDisplayName(workspace.DisplayName); err != nil {
			return nil, err
		}
		if err := AssertOpaqueID(workspace.WorkingDirectoryCapabilityID); err != nil {
			return nil, err
		}
		namespaces, err := parseRootNamespaces(fields["rootNamespaces"])
		if err != nil {
			return nil, err
		}
		workspace.RootNamespaces = namespaces
		workspaces = append(workspaces, workspace)
	}
	return workspaces, nil
}

func parseRootNamespaces(raw json.RawMessage) ([]RootNamespace, error) {
	var entries []json.RawMessage
	if json.Unmarshal(raw, &entries) != nil || entries == nil {
		return nil, ErrInvalid
	}
	namespaces := make([]RootNamespace, 0, len(entries))
	for _, entry := range entries {
		fields, err := decodeObject(entry)
		if err != nil {
			return nil, ErrInvalid
		}
		if !exactKeys(fields, "rootId", "namespace") {
			return nil, ErrInvalid
		}
		var binding RootNamespace
		if json.Unmarshal(fields["rootId"], &binding.RootID) != nil ||
			json.Unmarshal(fields["namespace"], &binding.Namespace) != nil {
			return nil, ErrInvalid
		}
		if err := AssertOpaqueID(binding.RootID); err != nil {
			return nil, err
		}
		if err := AssertWorkspaceNamespace(binding.Namespace); err != nil {
			return nil, err
		}
		namespaces = append(namespaces, binding)
	}
	return namespaces, nil
}

func decodeObject(raw []byte) (map[string]json.RawMessage, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	var fields map[string]json.RawMessage
	if err := decoder.Decode(&fields); err != nil || fields == nil {
		return nil, ErrInvalid
	}
	if decoder.More() {
		return nil, ErrInvalid
	}
	return fields, nil
}

func exactKeys(fields map[string]json.RawMessage, expected ...string) bool {
	if len(fields) != len(expected) {
		return false
	}
	for _, key := range expected {
		if _, present := fields[key]; !present {
			return false
		}
	}
	return true
}
