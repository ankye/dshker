package gitcheckout

import (
	"fmt"
	"regexp"
	"strings"
	"unicode"
)

// commitSHAPattern is the only object id this package admits: a full lowercase
// SHA. An abbreviated id is deliberately refused rather than expanded, because
// expanding one is what lets a mirror that moved since the selection decide which
// commit runs.
var commitSHAPattern = regexp.MustCompile(`^[0-9a-f]{40}$`)

// The three kinds of revision a user may select.
const (
	SelectionBranch = "branch"
	SelectionTag    = "tag"
	SelectionCommit = "commit"
)

// Selection is one branch, tag or exact commit, already validated.
type Selection struct {
	Kind   string `json:"kind"`
	Branch string `json:"branch,omitempty"`
	Tag    string `json:"tag,omitempty"`
	Commit string `json:"commit,omitempty"`
}

// ReferenceObservation is a previous mutable-reference observation, which is what
// detects a rewrite explicitly instead of trusting the mirror.
type ReferenceObservation struct {
	Selection      Selection `json:"selection"`
	Commit         string    `json:"commit"`
	ObservedObject string    `json:"observedObject"`
}

// SelectBranch builds a branch selection from a portable, unambiguous name.
func SelectBranch(branch string) (Selection, error) {
	if err := AssertReferenceShortName(branch, "Branch"); err != nil {
		return Selection{}, err
	}
	return Selection{Kind: SelectionBranch, Branch: branch}, nil
}

// SelectTag builds a tag selection from a portable, unambiguous name.
func SelectTag(tag string) (Selection, error) {
	if err := AssertReferenceShortName(tag, "Tag"); err != nil {
		return Selection{}, err
	}
	return Selection{Kind: SelectionTag, Tag: tag}, nil
}

// SelectCommit builds an exact commit selection. An abbreviated object id is
// refused, and so is anything that is not a commit.
func SelectCommit(commit string) (Selection, error) {
	sha, err := ParseCommitSHA(commit)
	if err != nil {
		return Selection{}, err
	}
	return Selection{Kind: SelectionCommit, Commit: sha}, nil
}

// ParseCommitSHA checks one full lowercase SHA and returns it unchanged.
func ParseCommitSHA(value string) (string, error) {
	if !commitSHAPattern.MatchString(value) {
		return "", fmt.Errorf("%w: Git commit must be a full lowercase SHA.", ErrRevisionInvalid)
	}
	return value, nil
}

// AssertSelection validates a selection that came from outside this package
// before any of it reaches a git argument.
func AssertSelection(selection Selection) error {
	switch selection.Kind {
	case SelectionBranch:
		if selection.Tag != "" || selection.Commit != "" {
			return fmt.Errorf("%w: Git revision selection is invalid.", ErrRevisionInvalid)
		}
		return AssertReferenceShortName(selection.Branch, "Branch")
	case SelectionTag:
		if selection.Branch != "" || selection.Commit != "" {
			return fmt.Errorf("%w: Git revision selection is invalid.", ErrRevisionInvalid)
		}
		return AssertReferenceShortName(selection.Tag, "Tag")
	case SelectionCommit:
		if selection.Branch != "" || selection.Tag != "" {
			return fmt.Errorf("%w: Git revision selection is invalid.", ErrRevisionInvalid)
		}
		_, err := ParseCommitSHA(selection.Commit)
		return err
	}
	return fmt.Errorf("%w: Git revision selection is invalid.", ErrRevisionInvalid)
}

// SameSelection reports whether two selections name the same revision.
func SameSelection(left, right Selection) bool {
	if left.Kind != right.Kind {
		return false
	}
	switch left.Kind {
	case SelectionBranch:
		return left.Branch == right.Branch
	case SelectionTag:
		return left.Tag == right.Tag
	case SelectionCommit:
		return left.Commit == right.Commit
	}
	return false
}

// AssertReferenceShortName applies git's own short-name rules, so a name that
// would be read as an option, a path or a revision expression is refused before
// it becomes an argument. The set is the shell's: a length bound, no leading
// refs/ or slash, no trailing slash, no whitespace or control character, and
// none of the characters git treats as punctuation.
func AssertReferenceShortName(value, subject string) error {
	if value == "" || len(value) > 1024 ||
		strings.HasPrefix(value, "refs/") || strings.HasPrefix(value, "/") || strings.HasSuffix(value, "/") {
		return fmt.Errorf("%w: %s name is invalid.", ErrRevisionInvalid, subject)
	}
	if strings.Contains(value, "..") || strings.Contains(value, "@{") || strings.Contains(value, "//") {
		return fmt.Errorf("%w: %s name is invalid.", ErrRevisionInvalid, subject)
	}
	for _, character := range value {
		switch character {
		case '~', '^', ':', '?', '*', '\\', '[', ' ':
			return fmt.Errorf("%w: %s name is invalid.", ErrRevisionInvalid, subject)
		}
		if character <= 0x1f || unicode.IsSpace(character) {
			return fmt.Errorf("%w: %s name is invalid.", ErrRevisionInvalid, subject)
		}
	}
	for _, segment := range strings.Split(value, "/") {
		if segment == "" || segment == "." || segment == ".." ||
			strings.HasSuffix(segment, ".lock") || strings.HasSuffix(segment, ".") {
			return fmt.Errorf("%w: %s name is invalid.", ErrRevisionInvalid, subject)
		}
	}
	return nil
}
