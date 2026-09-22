// Package harnessruntime owns the DSH Web child process: the exact command the
// Launcher used to run itself, the fixed port it may be asked to hold, the
// process tree it must not leave behind, and the console feed the shell renders.
//
// It is the Go half of electron/main/managed/{launcher-harness-service,
// port-occupancy,launch-preferences,child-output-observer,process-tree}.ts. The
// rules are ported rather than reinterpreted: the same argument order, the same
// port range, the same adopt-or-refuse decision, the same bounded console, and
// the same loopback-only URL announcement.
package harnessruntime

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// Refusal codes the shell already maps to its own messages. They cross the
// private channel unchanged, which is why the protocol declares the runtime
// family beside p2p, managed and launcher.
var (
	ErrInputInvalid        = errors.New("runtime.input_invalid")
	ErrWorktreeInvalid     = errors.New("runtime.worktree_invalid")
	ErrSpawnFailed         = errors.New("runtime.spawn_failed")
	ErrChildUnavailable    = errors.New("runtime.child_unavailable")
	ErrChildCrashed        = errors.New("runtime.child_crashed")
	ErrNotFound            = errors.New("runtime.not_found")
	ErrOperationInProgress = errors.New("runtime.operation_in_progress")
	ErrPortInUse           = errors.New("runtime.port_in_use")
	ErrShutdownTimeout     = errors.New("runtime.shutdown_timeout")
)

// Port bounds admittable as a fixed DSH Web port. They are the shell's own
// contract values; a privileged port is refused rather than launched.
const (
	MinPort = 1024
	MaxPort = 65535
)

// The named command profiles the core can run. ProfilePnpm is the Launcher's
// own DSH Web child — pnpm resolving the active checkout — and ProfileNode is
// one managed installation's built entry run by the Node that installation
// registered. An empty profile means ProfilePnpm, so the shell that was already
// asking for one keeps its exact command.
const (
	ProfilePnpm = "pnpm"
	ProfileNode = "node"
)

// ManagedEntryPath is the built DSH entry inside a managed checkout, spelled
// relative to the launch directory exactly as the shell spelled it.
const ManagedEntryPath = "apps/cli/lib/bin.js"

// PortSetting is either an automatic selection or one exact unprivileged port.
type PortSetting struct {
	Mode string `json:"mode"`
	Port int    `json:"port,omitempty"`
}

// AutoPort is the automatic selection the settings document defaults to.
func AutoPort() PortSetting { return PortSetting{Mode: "auto"} }

// FixedPort returns a fixed selection after checking the admitted range.
func FixedPort(port int) (PortSetting, error) {
	return AssertPortSetting(PortSetting{Mode: "fixed", Port: port})
}

// AssertPortSetting refuses anything but an automatic selection or an
// unprivileged port inside the admitted range.
func AssertPortSetting(setting PortSetting) (PortSetting, error) {
	if setting.Mode == "auto" {
		return AutoPort(), nil
	}
	if setting.Mode != "fixed" || setting.Port < MinPort || setting.Port > MaxPort {
		return PortSetting{}, fmt.Errorf(
			"%w: A fixed DSH web port must be an integer between %d and %d.",
			ErrInputInvalid, MinPort, MaxPort,
		)
	}
	return PortSetting{Mode: "fixed", Port: setting.Port}, nil
}

// LaunchRequest is everything one launch needs. The shell supplies the facts it
// owns — which checkout is active, which pnpm is packaged with the application,
// where the verbose overlay and the log live — and the core owns the child.
type LaunchRequest struct {
	LaunchID              string      `json:"launchId"`
	SubjectID             string      `json:"subjectId"`
	Directory             string      `json:"directory"`
	Profile               string      `json:"profile,omitempty"`
	NodeExecutable        string      `json:"nodeExecutable,omitempty"`
	PnpmExecutable        string      `json:"pnpmExecutable"`
	PnpmPrefixArguments   []string    `json:"pnpmPrefixArguments,omitempty"`
	PnpmResolutionError   string      `json:"pnpmResolutionError,omitempty"`
	PnpmCommandSearchPath string      `json:"pnpmCommandSearchPath,omitempty"`
	DiagnosticsPatchPath  string      `json:"diagnosticsPatchPath"`
	Port                  PortSetting `json:"port"`
	LogPath               string      `json:"logPath"`
}

var opaqueIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)

// AssertLaunchRequest validates one request before anything is spawned. Every
// path is required to be absolute and already normalized, so a caller cannot
// launch from a relative or ambiguous location.
//
// Each refusal names the field it rejected. One shared sentence for all eight
// checks made a refused launch unreadable: the shell logged "Managed DSH launch
// input is invalid" and the peer that asked for a runtime was refused with no way
// to tell an unresolved pnpm from a missing log path or a non-canonical checkout,
// which is exactly the diagnosis a user cannot perform and a maintainer had to
// guess at from the outside.
func AssertLaunchRequest(request LaunchRequest) error {
	if !opaqueIDPattern.MatchString(request.LaunchID) {
		return fmt.Errorf("%w: launchId is not an opaque id: %q", ErrInputInvalid, request.LaunchID)
	}
	if !opaqueIDPattern.MatchString(request.SubjectID) {
		return fmt.Errorf("%w: subjectId is not an opaque id: %q", ErrInputInvalid, request.SubjectID)
	}
	if !absoluteNormalized(request.Directory) {
		return fmt.Errorf("%w: directory is not an absolute normalized path: %q", ErrInputInvalid, request.Directory)
	}
	switch request.Profile {
	case ProfileNode:
		// A managed launch runs one installation's own Node against its own
		// checkout, so the pnpm facts are absent and the Node path is the fact
		// that must hold. The log is the shell's business and may be absent.
		if !absoluteNormalized(request.NodeExecutable) {
			return fmt.Errorf("%w: nodeExecutable is not an absolute normalized path: %q", ErrInputInvalid, request.NodeExecutable)
		}
		if request.LogPath != "" && !absoluteNormalized(request.LogPath) {
			return fmt.Errorf("%w: logPath is not an absolute normalized path: %q", ErrInputInvalid, request.LogPath)
		}
	case "", ProfilePnpm:
		for _, field := range []struct {
			name  string
			value string
		}{
			{"pnpmExecutable", request.PnpmExecutable},
			{"diagnosticsPatchPath", request.DiagnosticsPatchPath},
			{"logPath", request.LogPath},
		} {
			if !absoluteNormalized(field.value) {
				// An unresolved pnpm is the common cause here and the shell already
				// knows why, so carry its own explanation rather than making the user
				// discover it again.
				if field.name == "pnpmExecutable" && request.PnpmResolutionError != "" {
					return fmt.Errorf("%w: pnpmExecutable is unavailable: %s", ErrInputInvalid, request.PnpmResolutionError)
				}
				return fmt.Errorf("%w: %s is not an absolute normalized path: %q", ErrInputInvalid, field.name, field.value)
			}
		}
	default:
		return fmt.Errorf("%w: unknown launch profile: %q", ErrInputInvalid, request.Profile)
	}
	if _, err := AssertPortSetting(request.Port); err != nil {
		return err
	}
	return nil
}

func absoluteNormalized(value string) bool {
	return value != "" && filepath.IsAbs(value) && filepath.Clean(value) == value
}

// Command is one fully constructed child invocation.
type Command struct {
	Executable string   `json:"executable"`
	Arguments  []string `json:"arguments"`
	Directory  string   `json:"directory"`
	// Path overrides the child's PATH, and is empty when the parent's is used.
	Path string `json:"path,omitempty"`
}

// BuildCommand renders the exact command the shell used to spawn itself:
// `pnpm dsh web --patch <overlay> --no-open [--port <port>]`, run from the
// active version directory. A pnpm shim contributes its prefix arguments and the
// PATH its subprocesses need, and a shim that could not be resolved is refused
// rather than launched.
func BuildCommand(request LaunchRequest) (Command, error) {
	if err := AssertLaunchRequest(request); err != nil {
		return Command{}, err
	}
	if request.Profile == ProfileNode {
		if err := AssertBuiltEntry(request.Directory); err != nil {
			return Command{}, err
		}
		arguments := make([]string, 0, 4)
		arguments = append(arguments, ManagedEntryPath, "web", "--no-open")
		if request.Port.Mode == "fixed" {
			arguments = append(arguments, "--port", strconv.Itoa(request.Port.Port))
		}
		return Command{
			Executable: request.NodeExecutable,
			Arguments:  arguments,
			Directory:  request.Directory,
		}, nil
	}
	if request.PnpmResolutionError != "" {
		return Command{}, fmt.Errorf("%w: %s", ErrSpawnFailed, request.PnpmResolutionError)
	}
	arguments := make([]string, 0, len(request.PnpmPrefixArguments)+7)
	arguments = append(arguments, request.PnpmPrefixArguments...)
	arguments = append(arguments, "dsh", "web", "--patch", request.DiagnosticsPatchPath, "--no-open")
	if request.Port.Mode == "fixed" {
		arguments = append(arguments, "--port", strconv.Itoa(request.Port.Port))
	}
	return Command{
		Executable: request.PnpmExecutable,
		Arguments:  arguments,
		Directory:  request.Directory,
		Path:       request.PnpmCommandSearchPath,
	}, nil
}

// AssertBuiltEntry refuses a managed checkout whose built DSH entry is missing,
// indirect or not the file the entry claims to be. It is the shell's own rule —
// a symlink or a replaced file could run something other than the checkout the
// installation record points at — applied before the core spawns anything.
func AssertBuiltEntry(directory string) error {
	if !absoluteNormalized(directory) {
		return fmt.Errorf("%w: Managed DSH launch input is invalid.", ErrInputInvalid)
	}
	// The directory itself may be reached through a link (a temporary directory
	// on macOS is), so it is resolved first: what must be direct is the entry.
	resolvedDirectory, err := filepath.EvalSymlinks(directory)
	if err != nil {
		return fmt.Errorf("%w: Managed Harness has no direct built dsh entry.", ErrWorktreeInvalid)
	}
	entry := filepath.Join(resolvedDirectory, filepath.FromSlash(ManagedEntryPath))
	info, err := os.Lstat(entry)
	if err != nil || info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return fmt.Errorf("%w: Managed Harness has no direct built dsh entry.", ErrWorktreeInvalid)
	}
	resolved, err := filepath.EvalSymlinks(entry)
	if err != nil || resolved != entry {
		return fmt.Errorf("%w: Managed Harness has no direct built dsh entry.", ErrWorktreeInvalid)
	}
	return nil
}

// announcedURLPattern is DSH's own startup line. The query and fragment are
// preserved because DSH may place a session credential there.
var announcedURLPattern = regexp.MustCompile(`(?m)^dsh web:\s*(\S+)`)

// ParseAnnouncedWebURL reads the exact loopback URL from DSH's startup line.
// Only an http(s) loopback origin is accepted, so a log line quoting some other
// address can never redirect the Launcher's runtime view.
func ParseAnnouncedWebURL(text string) (string, bool) {
	matched := announcedURLPattern.FindStringSubmatch(text)
	if matched == nil {
		return "", false
	}
	parsed, err := url.Parse(matched[1])
	if err != nil || parsed.Host == "" {
		return "", false
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", false
	}
	host := strings.ToLower(parsed.Hostname())
	if host != "127.0.0.1" && host != "localhost" && host != "::1" {
		return "", false
	}
	// The JavaScript URL parser lower-cases the host, brackets an IPv6 literal and
	// renders an empty path as "/", and the announced address is copied by the
	// user, so this reproduces that spelling rather than Go's.
	port := parsed.Port()
	switch {
	case port != "" && host == "::1":
		parsed.Host = "[" + host + "]:" + port
	case port != "":
		parsed.Host = host + ":" + port
	case host == "::1":
		parsed.Host = "[::1]"
	default:
		parsed.Host = host
	}
	if parsed.Path == "" {
		parsed.Path = "/"
	}
	return parsed.String(), true
}
