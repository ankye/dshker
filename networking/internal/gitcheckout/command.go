package gitcheckout

import (
	"context"
	"fmt"
	"strings"
)

// RunRequiredGitCommand runs one named operation that must complete
// successfully.
func RunRequiredGitCommand(ctx context.Context, runner *Runner, executable Executable, context ExecutionContext, command Command) (Result, error) {
	result, err := runner.Run(ctx, executable, context, command)
	if err != nil {
		return Result{}, err
	}
	return result, RequireSuccess(result)
}

// RequireSingleGitLine extracts exactly one non-empty line from a git protocol
// response. A git that answered with nothing, or with two lines, has not answered
// the question that was asked.
func RequireSingleGitLine(value, subject string) (string, error) {
	lines := make([]string, 0, 1)
	for _, line := range strings.Split(strings.ReplaceAll(value, "\r\n", "\n"), "\n") {
		if line != "" {
			lines = append(lines, line)
		}
	}
	if len(lines) != 1 {
		return "", fmt.Errorf("%w: %s did not resolve to exactly one value.", ErrRefAmbiguous, subject)
	}
	return lines[0], nil
}

// RequireGitReferenceCommand reads a command failure that specifically means an
// unavailable reference: git exits 1 or 128 for a ref it cannot resolve, and
// anything else is a command failure with the bounded observation attached.
func RequireGitReferenceCommand(result Result, subject string) (Result, error) {
	if result.ExitCode != nil && *result.ExitCode == 0 {
		return result, nil
	}
	if result.ExitCode != nil && (*result.ExitCode == 1 || *result.ExitCode == 128) {
		return Result{}, fmt.Errorf("%w: %s is unavailable in the fetched mirror.", ErrRefMissing, subject)
	}
	return Result{}, RequireSuccess(result)
}

// IsGitAncestryResult reads a merge-base style predicate: exit 0 is true, exit 1
// is false, and anything else is a command failure rather than a false answer.
func IsGitAncestryResult(result Result) (bool, error) {
	if result.ExitCode != nil && *result.ExitCode == 0 {
		return true, nil
	}
	if result.ExitCode != nil && *result.ExitCode == 1 {
		return false, nil
	}
	return false, RequireSuccess(result)
}
