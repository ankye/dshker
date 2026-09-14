package gitcheckout

import (
	"fmt"
	"path/filepath"
	"regexp"
	"strings"
)

// The baseline every git invocation runs with. Git is told to read no system or
// global configuration, never to prompt, and not to take optional locks — the
// core runs git on files it owns and must not inherit whatever the machine
// happens to be configured with.
var RequiredGitEnvironment = map[string]string{
	"GIT_CONFIG_NOSYSTEM": "1",
	"GIT_CONFIG_COUNT":    "0",
	"GIT_TERMINAL_PROMPT": "0",
	"GIT_OPTIONAL_LOCKS":  "0",
}

// ForbiddenGitEnvironmentNames are the ambient inputs a git invocation must never
// carry: a search path, a home directory, git's own location overrides, any
// authentication helper, and the agent socket. They are refused by name rather
// than merely not being allowed, because the diagnostic is what tells an operator
// which of them leaked in.
var ForbiddenGitEnvironmentNames = []string{
	"PATH",
	"HOME",
	"USERPROFILE",
	"HOMEDRIVE",
	"HOMEPATH",
	"XDG_CONFIG_HOME",
	"XDG_CACHE_HOME",
	"XDG_DATA_HOME",
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_CEILING_DIRECTORIES",
	"GIT_EXEC_PATH",
	"GIT_TEMPLATE_DIR",
	"GIT_CONFIG_SYSTEM",
	"GIT_CONFIG_GLOBAL",
	"GIT_CONFIG_NOSYSTEM",
	"GIT_CONFIG_COUNT",
	"GIT_TERMINAL_PROMPT",
	"GIT_OPTIONAL_LOCKS",
	"GIT_ASKPASS",
	"SSH_ASKPASS",
	"SSH_AUTH_SOCK",
	"GIT_SSH",
	"GIT_SSH_COMMAND",
}

// windowsEnvironmentNames are the platform process variables a direct Windows
// executable needs to start at all. They are accepted on every platform, because
// they are checked before the platform is known.
var windowsEnvironmentNames = []string{"SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"}

// EnvironmentVariablePattern is the only name shape an environment entry may
// have. A name that is not a plain identifier cannot be passed to a process
// without an argument vector trick.
var EnvironmentVariablePattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// ExecutionContext is the explicit, already-approved context of one invocation.
// Nothing about it is inferred from the ambient environment.
type ExecutionContext struct {
	WorkingDirectory    string
	Environment         map[string]string
	TimeoutMilliseconds int
	MaximumOutputBytes  int
}

// Execution bounds, the same ones the shell enforces.
const (
	MinimumTimeoutMilliseconds = 1
	MaximumTimeoutMilliseconds = 300_000
	MinimumOutputBytes         = 1
	MaximumOutputBytes         = 4 * 1024 * 1024
)

// CreateExecutionEnvironment builds the only baseline an invocation may use.
// Windows needs four process variables that nothing else may supply, so they are
// registered explicitly or the context is refused.
func CreateExecutionEnvironment(platform, systemRoot, windir, comspec, pathExt string) (map[string]string, error) {
	environment := make(map[string]string, len(RequiredGitEnvironment)+5)
	for name, value := range RequiredGitEnvironment {
		environment[name] = value
	}
	if platform == "windows" || platform == "win32" {
		if systemRoot == "" || windir == "" || comspec == "" || pathExt == "" {
			return nil, fmt.Errorf("%w: Windows Git execution requires explicitly registered Windows process variables.", ErrCommandInvalid)
		}
		environment["GIT_CONFIG_GLOBAL"] = "NUL"
		environment["SYSTEMROOT"] = systemRoot
		environment["WINDIR"] = windir
		environment["COMSPEC"] = comspec
		environment["PATHEXT"] = pathExt
		return environment, nil
	}
	environment["GIT_CONFIG_GLOBAL"] = "/dev/null"
	return environment, nil
}

// AssertExecutionContext refuses an ambient home, a search path, a git
// configuration override or an authentication helper, and bounds the two numbers
// the runner will honour.
func AssertExecutionContext(context ExecutionContext) error {
	if err := AssertCanonicalAbsolutePath(context.WorkingDirectory, "Git working directory", ErrCommandInvalid); err != nil {
		return err
	}
	if context.TimeoutMilliseconds < MinimumTimeoutMilliseconds || context.TimeoutMilliseconds > MaximumTimeoutMilliseconds {
		return fmt.Errorf("%w: Git command timeout is invalid.", ErrCommandInvalid)
	}
	if context.MaximumOutputBytes < MinimumOutputBytes || context.MaximumOutputBytes > MaximumOutputBytes {
		return fmt.Errorf("%w: Git command output limit is invalid.", ErrCommandInvalid)
	}

	normalized := make(map[string]string, len(context.Environment))
	for name, value := range context.Environment {
		if !EnvironmentVariablePattern.MatchString(name) || strings.ContainsRune(value, 0) {
			return fmt.Errorf("%w: Git command environment is invalid.", ErrCommandInvalid)
		}
		upper := strings.ToUpper(name)
		if _, duplicate := normalized[upper]; duplicate {
			return fmt.Errorf("%w: Git command environment contains duplicate names.", ErrCommandInvalid)
		}
		normalized[upper] = value
	}
	for name, value := range RequiredGitEnvironment {
		if normalized[name] != value {
			return fmt.Errorf("%w: Git command environment must set %s.", ErrCommandInvalid, name)
		}
	}
	if global := normalized["GIT_CONFIG_GLOBAL"]; global != "/dev/null" && global != "NUL" {
		return fmt.Errorf("%w: Git command environment must disable global Git configuration.", ErrCommandInvalid)
	}
	for name := range normalized {
		if allowedEnvironmentName(name) {
			continue
		}
		if isForbiddenEnvironmentName(name) {
			return fmt.Errorf("%w: Git command environment contains an unapproved variable (%s is forbidden).", ErrCommandInvalid, name)
		}
		return fmt.Errorf("%w: Git command environment contains an unapproved variable (%s).", ErrCommandInvalid, name)
	}
	return nil
}

func allowedEnvironmentName(name string) bool {
	if _, required := RequiredGitEnvironment[name]; required {
		return true
	}
	if name == "GIT_CONFIG_GLOBAL" {
		return true
	}
	for _, windowsName := range windowsEnvironmentNames {
		if name == windowsName {
			return true
		}
	}
	return false
}

func isForbiddenEnvironmentName(name string) bool {
	for _, forbidden := range ForbiddenGitEnvironmentNames {
		if name == forbidden {
			return true
		}
	}
	return false
}

// AssertCanonicalAbsolutePath refuses a path that is relative, non-canonical or
// a filesystem root, so a command can never be pointed at an ambiguous location.
func AssertCanonicalAbsolutePath(value, subject string, code error) error {
	if value == "" || strings.ContainsRune(value, 0) || !filepath.IsAbs(value) {
		return fmt.Errorf("%w: %s must be an absolute path.", code, subject)
	}
	if filepath.Clean(value) != value {
		return fmt.Errorf("%w: %s must be canonical and non-root.", code, subject)
	}
	if filepath.Dir(value) == value {
		return fmt.Errorf("%w: %s must be canonical and non-root.", code, subject)
	}
	return nil
}
