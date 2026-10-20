package runtimeowner

import (
	"bytes"
	"encoding/json"
	"io"
	"net/url"

	"github.com/ankye/dshker/networking/internal/harnessruntime"
)

type hello struct {
	Version        int             `json:"version"`
	Config         Config          `json:"config"`
	ExecutableHash string          `json:"executableHash"`
	RootsHash      string          `json:"rootsHash"`
	Home           homeContext     `json:"home"`
	Instance       string          `json:"instance"`
	Process        processIdentity `json:"process"`
}

func helloFor(record ownerRecord) hello {
	return hello{record.Version, record.Config, record.ExecutableHash, record.RootsHash, record.Home, record.Instance, record.Process}
}

type startRequest struct {
	LaunchID              string                     `json:"launchId"`
	SubjectID             string                     `json:"subjectId"`
	Directory             string                     `json:"directory"`
	Profile               string                     `json:"profile"`
	NodeExecutable        string                     `json:"nodeExecutable"`
	PnpmExecutable        string                     `json:"pnpmExecutable"`
	PnpmPrefixArguments   []string                   `json:"pnpmPrefixArguments"`
	PnpmResolutionError   string                     `json:"pnpmResolutionError"`
	PnpmCommandSearchPath string                     `json:"pnpmCommandSearchPath"`
	DiagnosticsPatchPath  string                     `json:"diagnosticsPatchPath"`
	Port                  harnessruntime.PortSetting `json:"port"`
	LogPath               string                     `json:"logPath"`
}

func startWire(request harnessruntime.LaunchRequest) startRequest {
	return startRequest{request.LaunchID, request.SubjectID, request.Directory, request.Profile, request.NodeExecutable, request.PnpmExecutable, append([]string{}, request.PnpmPrefixArguments...), request.PnpmResolutionError, request.PnpmCommandSearchPath, request.DiagnosticsPatchPath, request.Port, request.LogPath}
}

func (request startRequest) launch() harnessruntime.LaunchRequest {
	return harnessruntime.LaunchRequest{LaunchID: request.LaunchID, SubjectID: request.SubjectID, Directory: request.Directory, Profile: request.Profile, NodeExecutable: request.NodeExecutable, PnpmExecutable: request.PnpmExecutable, PnpmPrefixArguments: request.PnpmPrefixArguments, PnpmResolutionError: request.PnpmResolutionError, PnpmCommandSearchPath: request.PnpmCommandSearchPath, DiagnosticsPatchPath: request.DiagnosticsPatchPath, Port: request.Port, LogPath: request.LogPath}
}

type subjectRequest struct {
	Subject string `json:"subjectId"`
}

type consoleRequest struct {
	Cursor int64 `json:"cursor"`
}

type launchResult struct {
	Launch json.RawMessage `json:"launch"`
}

type statusResult struct {
	Present bool            `json:"present"`
	Launch  json.RawMessage `json:"launch"`
}

type consoleResult struct {
	Entries []harnessruntime.ConsoleEntry `json:"entries"`
	Cursor  int64                         `json:"cursor"`
}

type shutdownResult struct {
	Stopped bool `json:"stopped"`
}

func encodeLaunch(view harnessruntime.LaunchView) json.RawMessage {
	encoded, _ := json.Marshal(view)
	return encoded
}

// LaunchView has explicitly optional JSON members, unlike the exact private
// envelopes. Their absence is admitted, but unknown fields and missing identity
// must not become an invented running launch.
func decodeLaunch(raw json.RawMessage) (harnessruntime.LaunchView, error) {
	var view harnessruntime.LaunchView
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&view) != nil || decoder.Decode(new(any)) != io.EOF || view.LaunchID == "" || view.SubjectID == "" || view.Directory == "" {
		return view, ErrOwnerProtocol
	}
	switch view.State {
	case harnessruntime.StateStarting, harnessruntime.StateRunning, harnessruntime.StateStopped, harnessruntime.StateFailed:
	default:
		return view, ErrOwnerProtocol
	}
	if view.State == harnessruntime.StateRunning && (view.PID <= 0 || !validBindingURL(view.URL)) {
		return view, ErrOwnerProtocol
	}
	return view, nil
}

func validBindingURL(value string) bool {
	parsed, err := url.Parse(value)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.User != nil {
		return false
	}
	switch parsed.Hostname() {
	case "127.0.0.1", "::1", "localhost":
		return true
	}
	return false
}
