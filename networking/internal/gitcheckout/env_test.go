package gitcheckout

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

func TestCreateExecutionEnvironmentIsTheOnlyBaseline(t *testing.T) {
	posix, err := CreateExecutionEnvironment("darwin", "", "", "", "")
	if err != nil {
		t.Fatalf("posix: %v", err)
	}
	for name, value := range RequiredGitEnvironment {
		if posix[name] != value {
			t.Errorf("posix environment %s = %q, want %q", name, posix[name], value)
		}
	}
	if posix["GIT_CONFIG_GLOBAL"] != "/dev/null" {
		t.Fatalf("posix GIT_CONFIG_GLOBAL = %q", posix["GIT_CONFIG_GLOBAL"])
	}
	if len(posix) != len(RequiredGitEnvironment)+1 {
		t.Fatalf("posix environment carries %d entries, want %d", len(posix), len(RequiredGitEnvironment)+1)
	}

	windows, err := CreateExecutionEnvironment("win32", `C:\Windows`, `C:\Windows`, `C:\Windows\system32\cmd.exe`, ".COM;.EXE")
	if err != nil {
		t.Fatalf("windows: %v", err)
	}
	if windows["GIT_CONFIG_GLOBAL"] != "NUL" {
		t.Fatalf("windows GIT_CONFIG_GLOBAL = %q", windows["GIT_CONFIG_GLOBAL"])
	}
	for _, name := range []string{"SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT"} {
		if windows[name] == "" {
			t.Errorf("windows environment is missing %s", name)
		}
	}
	if _, err = CreateExecutionEnvironment("win32", `C:\Windows`, "", "", ""); !errors.Is(err, ErrCommandInvalid) {
		t.Fatalf("windows without its process variables = %v", err)
	}
}

// TestAssertExecutionContextRefusesAmbientInput is the rule that keeps a git
// invocation from inheriting whatever the machine happens to be configured with:
// no search path, no home, no git location override, no authentication helper.
func TestAssertExecutionContextRefusesAmbientInput(t *testing.T) {
	base := func() ExecutionContext {
		environment, err := CreateExecutionEnvironment("darwin", "", "", "", "")
		if err != nil {
			t.Fatal(err)
		}
		return ExecutionContext{
			WorkingDirectory:    t.TempDir(),
			Environment:         environment,
			TimeoutMilliseconds: 30_000,
			MaximumOutputBytes:  1 << 20,
		}
	}
	if err := AssertExecutionContext(base()); err != nil {
		t.Fatalf("baseline context = %v", err)
	}

	cases := []struct {
		name   string
		change func(context *ExecutionContext)
	}{
		{name: "relative working directory", change: func(c *ExecutionContext) { c.WorkingDirectory = "relative/path" }},
		{name: "non-canonical working directory", change: func(c *ExecutionContext) {
			c.WorkingDirectory = filepath.Join(c.WorkingDirectory, "..", filepath.Base(c.WorkingDirectory)) + "/."
		}},
		{name: "root working directory", change: func(c *ExecutionContext) { c.WorkingDirectory = "/" }},
		{name: "zero timeout", change: func(c *ExecutionContext) { c.TimeoutMilliseconds = 0 }},
		{name: "timeout above the bound", change: func(c *ExecutionContext) { c.TimeoutMilliseconds = MaximumTimeoutMilliseconds + 1 }},
		{name: "zero output limit", change: func(c *ExecutionContext) { c.MaximumOutputBytes = 0 }},
		{name: "output limit above the bound", change: func(c *ExecutionContext) { c.MaximumOutputBytes = MaximumOutputBytes + 1 }},
		{name: "missing required name", change: func(c *ExecutionContext) { delete(c.Environment, "GIT_TERMINAL_PROMPT") }},
		{name: "required name with the wrong value", change: func(c *ExecutionContext) { c.Environment["GIT_CONFIG_NOSYSTEM"] = "0" }},
		{name: "global configuration enabled", change: func(c *ExecutionContext) { c.Environment["GIT_CONFIG_GLOBAL"] = "/home/user/.gitconfig" }},
		{name: "unapproved name", change: func(c *ExecutionContext) { c.Environment["SOMETHING"] = "1" }},
		{name: "search path", change: func(c *ExecutionContext) { c.Environment["PATH"] = "/usr/bin" }},
		{name: "home directory", change: func(c *ExecutionContext) { c.Environment["HOME"] = "/Users/someone" }},
		{name: "authentication helper", change: func(c *ExecutionContext) { c.Environment["GIT_ASKPASS"] = "/usr/bin/echo" }},
		{name: "ssh agent socket", change: func(c *ExecutionContext) { c.Environment["SSH_AUTH_SOCK"] = "/tmp/agent" }},
		{name: "git location override", change: func(c *ExecutionContext) { c.Environment["GIT_DIR"] = "/tmp/git" }},
		{name: "invalid name", change: func(c *ExecutionContext) { c.Environment["1BAD"] = "1" }},
		{name: "name with a space", change: func(c *ExecutionContext) { c.Environment["BAD NAME"] = "1" }},
		{name: "value with a null", change: func(c *ExecutionContext) { c.Environment["GIT_CONFIG_GLOBAL"] = "\x00" }},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			context := base()
			testCase.change(&context)
			if err := AssertExecutionContext(context); !errors.Is(err, ErrCommandInvalid) {
				t.Fatalf("context was accepted: %v", err)
			}
		})
	}
}

// TestAssertExecutionContextSpellsDuplicatesAndForbiddenNames: a name is compared
// the way a process environment is, case-insensitively, and a forbidden name is
// named as forbidden because that is the sentence that tells an operator which
// ambient input leaked in.
func TestAssertExecutionContextSpellsDuplicatesAndForbiddenNames(t *testing.T) {
	environment, err := CreateExecutionEnvironment("darwin", "", "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	environment["git_config_global"] = "/dev/null"
	duplicate := ExecutionContext{
		WorkingDirectory:    t.TempDir(),
		Environment:         environment,
		TimeoutMilliseconds: 1_000,
		MaximumOutputBytes:  1_024,
	}
	if err := AssertExecutionContext(duplicate); !errors.Is(err, ErrCommandInvalid) || !strings.Contains(err.Error(), "duplicate") {
		t.Fatalf("case-insensitive duplicate = %v", err)
	}

	environment, err = CreateExecutionEnvironment("darwin", "", "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	environment["PATH"] = "/usr/bin"
	forbidden := ExecutionContext{
		WorkingDirectory:    t.TempDir(),
		Environment:         environment,
		TimeoutMilliseconds: 1_000,
		MaximumOutputBytes:  1_024,
	}
	err = AssertExecutionContext(forbidden)
	if !errors.Is(err, ErrCommandInvalid) || !strings.Contains(err.Error(), "PATH is forbidden") {
		t.Fatalf("forbidden name = %v", err)
	}
}

// TestAssertCanonicalAbsolutePath holds the shape every path in this package must
// have before it becomes a git argument.
func TestAssertCanonicalAbsolutePath(t *testing.T) {
	if err := AssertCanonicalAbsolutePath(t.TempDir(), "subject", ErrCommandInvalid); err != nil {
		t.Fatalf("temp dir = %v", err)
	}
	for _, value := range []string{"", "relative", "/", "/tmp/..", "\x00", "/tmp/./x"} {
		if err := AssertCanonicalAbsolutePath(value, "subject", ErrCommandInvalid); !errors.Is(err, ErrCommandInvalid) {
			t.Errorf("AssertCanonicalAbsolutePath(%q) = %v", value, err)
		}
	}
}
