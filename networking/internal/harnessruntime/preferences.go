package harnessruntime

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// PreferencesFormat and PreferencesFileName identify the one document the core
// owns below the Launcher directory. The shell wrote it before this package
// existed, so the bytes and the reader are unchanged.
const (
	PreferencesFormat   = "dsh-launcher.launch-preferences"
	PreferencesFileName = "launch-preferences.json"
	// MaxPreferencesBytes bounds a file this process reads into memory.
	MaxPreferencesBytes = 64 * 1024
)

// ErrPreferencesFailed reports an unusable preferences location, never an
// unusable preference: a record this build cannot read means "automatic port",
// which is the decision the shell made before the core owned the file.
var ErrPreferencesFailed = errors.New("runtime.preferences_failed")

// PreferencesStore reads and replaces the launch preferences document.
type PreferencesStore struct {
	filePath string
}

// OpenPreferences accepts only the one file name this package owns, so the
// location is not a caller's choice.
func OpenPreferences(filePath string) (*PreferencesStore, error) {
	if filePath == "" || !filepath.IsAbs(filePath) || filepath.Base(filePath) != PreferencesFileName {
		return nil, fmt.Errorf("%w: %s is not the managed launch preferences file.", ErrPreferencesFailed, filePath)
	}
	return &PreferencesStore{filePath: filePath}, nil
}

// Load reads the persisted port, returning the automatic selection for a missing
// or unusable record. It never fails on content, only on a location it cannot read.
func (store *PreferencesStore) Load() (PortSetting, error) {
	info, err := os.Lstat(store.filePath)
	if errors.Is(err, os.ErrNotExist) {
		return AutoPort(), nil
	}
	if err != nil {
		return AutoPort(), fmt.Errorf("%w: %v", ErrPreferencesFailed, err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() || info.Size() > MaxPreferencesBytes {
		return AutoPort(), fmt.Errorf("%w: the launch preferences file is not a readable document.", ErrPreferencesFailed)
	}
	data, err := os.ReadFile(store.filePath)
	if err != nil {
		return AutoPort(), fmt.Errorf("%w: %v", ErrPreferencesFailed, err)
	}
	return ParseLaunchPreferences(data), nil
}

// Save replaces the document atomically. A refused setting never reaches disk.
func (store *PreferencesStore) Save(setting PortSetting) error {
	asserted, err := AssertPortSetting(setting)
	if err != nil {
		return err
	}
	encoded, err := EncodeLaunchPreferences(asserted)
	if err != nil {
		return err
	}
	temporary := store.filePath + ".tmp"
	if err := os.WriteFile(temporary, encoded, 0o600); err != nil {
		return fmt.Errorf("%w: %v", ErrPreferencesFailed, err)
	}
	if err := os.Rename(temporary, store.filePath); err != nil {
		_ = os.Remove(temporary)
		return fmt.Errorf("%w: %v", ErrPreferencesFailed, err)
	}
	return nil
}

// ParseLaunchPreferences reads a persisted port, returning the automatic
// selection for anything this build cannot use. A missing or foreign document is
// an invitation to choose, never a launch failure.
func ParseLaunchPreferences(data []byte) PortSetting {
	var document struct {
		Format string `json:"format"`
		Port   struct {
			Mode string  `json:"mode"`
			Port float64 `json:"port"`
		} `json:"port"`
	}
	if json.Unmarshal(data, &document) != nil {
		return AutoPort()
	}
	if document.Format != PreferencesFormat || document.Port.Mode != "fixed" {
		return AutoPort()
	}
	port := int(document.Port.Port)
	if float64(port) != document.Port.Port {
		return AutoPort()
	}
	asserted, err := AssertPortSetting(PortSetting{Mode: "fixed", Port: port})
	if err != nil {
		return AutoPort()
	}
	return asserted
}

// EncodeLaunchPreferences renders the document the shell wrote:
// JSON.stringify({format, port}, null, 2) plus a trailing newline.
func EncodeLaunchPreferences(setting PortSetting) ([]byte, error) {
	asserted, err := AssertPortSetting(setting)
	if err != nil {
		return nil, err
	}
	format, err := json.Marshal(PreferencesFormat)
	if err != nil {
		return nil, err
	}
	mode, err := json.Marshal(asserted.Mode)
	if err != nil {
		return nil, err
	}
	var buffer bytes.Buffer
	buffer.WriteString("{\n  \"format\": ")
	buffer.Write(format)
	buffer.WriteString(",\n  \"port\": {\n    \"mode\": ")
	buffer.Write(mode)
	if asserted.Mode == "fixed" {
		buffer.WriteString(",\n    \"port\": ")
		buffer.WriteString(strconv.Itoa(asserted.Port))
	}
	buffer.WriteString("\n  }\n}\n")
	return buffer.Bytes(), nil
}

// IsResidualDshWebCommand recognizes a DSH Web process the Launcher itself
// started, so a leftover instance is adopted instead of refusing to launch
// forever. A foreign holder is never adopted.
func IsResidualDshWebCommand(commandLine string) bool {
	if strings.TrimSpace(commandLine) == "" {
		return false
	}
	return residualDshWebPattern.MatchString(commandLine)
}

// residualDshWebPattern is the shell's own recognition rule: a direct `dsh web`
// invocation or the built entry point it runs.
//
// The quotes are part of the rule because the command line is read back in the
// form the platform renders it, and Windows renders every argument of a spawn
// with quotes: `bin.ts "web" "--patch" "…"`. Without them a leftover instance the
// launcher itself started is classified as a foreign holder, and the launch is
// refused with runtime.port_in_use forever — the one case this rule exists to
// prevent.
var residualDshWebPattern = regexp.MustCompile(`(?:\bdsh\b|bin\.(?:j|t)s)["']?\s+["']?web\b`)
