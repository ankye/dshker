package gitcheckout

import (
	"errors"
	"strings"
	"testing"
)

const fullSHA = "8f3c1f0a4d2b6e9c7a5f4d3b2a1908f7e6d5c4b3"

// TestParseCommitSHA pins the only object id this package admits: a full
// lowercase SHA. An abbreviated id or a revision expression is refused rather
// than resolved, because resolving one lets the mirror decide which commit runs.
func TestParseCommitSHA(t *testing.T) {
	if sha, err := ParseCommitSHA(fullSHA); err != nil || sha != fullSHA {
		t.Fatalf("full sha = %q, %v", sha, err)
	}
	for _, value := range []string{
		"",
		"8f3c1f0",
		strings.ToUpper(fullSHA),
		fullSHA + "0",
		fullSHA[:39],
		"HEAD",
		fullSHA + "^{commit}",
		"refs/heads/main",
	} {
		if _, err := ParseCommitSHA(value); !errors.Is(err, ErrRefInvalid) {
			t.Errorf("ParseCommitSHA(%q) = %v, want git.ref_invalid", value, err)
		}
	}
	if _, err := SelectCommit(fullSHA); err != nil {
		t.Fatalf("select commit: %v", err)
	}
	if _, err := SelectCommit("main"); !errors.Is(err, ErrRefInvalid) {
		t.Fatalf("select branch as a commit = %v", err)
	}
}

// TestReferenceShortNames applies git's own short-name rules: a name that would
// be read as an option, a path or a revision expression is refused before it
// becomes an argument.
func TestReferenceShortNames(t *testing.T) {
	accepted := []string{"main", "feature/one", "v1.2.3", "release-2024.1", "a", "team/sub/branch"}
	for _, name := range accepted {
		if _, err := SelectBranch(name); err != nil {
			t.Errorf("SelectBranch(%q) = %v", name, err)
		}
		if _, err := SelectTag(name); err != nil {
			t.Errorf("SelectTag(%q) = %v", name, err)
		}
	}
	refused := []string{
		"",
		"refs/heads/main",
		"/main",
		"main/",
		"a..b",
		"a@{1}",
		"a//b",
		"a.lock",
		"a.",
		"a b",
		"a\tb",
		"a~1",
		"a^",
		"a:b",
		"a?b",
		"a*b",
		"a[b",
		"a\\b",
		"a\x00b",
		"a\x1fb",
		strings.Repeat("a", 1025),
	}
	for _, name := range refused {
		if _, err := SelectBranch(name); !errors.Is(err, ErrRefInvalid) {
			t.Errorf("SelectBranch(%q) = %v, want git.ref_invalid", name, err)
		}
	}
}

// TestAssertSelectionChecksTheWholeRecord: a selection that came from outside is
// validated as a record, so a branch selection cannot smuggle a commit and an
// unknown kind is refused rather than ignored.
func TestAssertSelectionChecksTheWholeRecord(t *testing.T) {
	branch, err := SelectBranch("main")
	if err != nil {
		t.Fatal(err)
	}
	tag, err := SelectTag("v1.2.3")
	if err != nil {
		t.Fatal(err)
	}
	commit, err := SelectCommit(fullSHA)
	if err != nil {
		t.Fatal(err)
	}
	for _, selection := range []Selection{branch, tag, commit} {
		if err := AssertSelection(selection); err != nil {
			t.Errorf("AssertSelection(%+v) = %v", selection, err)
		}
	}
	refused := []Selection{
		{},
		{Kind: "branch"},
		{Kind: "branch", Branch: "main", Commit: fullSHA},
		{Kind: "tag", Tag: "v1", Branch: "main"},
		{Kind: "commit", Commit: "main"},
		{Kind: "commit", Commit: fullSHA, Tag: "v1"},
		{Kind: "head", Branch: "main"},
		{Kind: "branch", Branch: "refs/heads/main"},
	}
	for _, selection := range refused {
		if err := AssertSelection(selection); !errors.Is(err, ErrRefInvalid) {
			t.Errorf("AssertSelection(%+v) = %v, want git.ref_invalid", selection, err)
		}
	}
}

// TestSameSelection compares what the user selected, not how it was spelled.
func TestSameSelection(t *testing.T) {
	branch, _ := SelectBranch("main")
	otherBranch, _ := SelectBranch("release")
	tag, _ := SelectTag("v1.2.3")
	commit, _ := SelectCommit(fullSHA)

	if !SameSelection(branch, branch) || SameSelection(branch, otherBranch) {
		t.Fatal("branch comparison is wrong")
	}
	if SameSelection(branch, tag) || SameSelection(tag, commit) || SameSelection(branch, commit) {
		t.Fatal("different kinds compared equal")
	}
	if !SameSelection(tag, tag) || !SameSelection(commit, commit) {
		t.Fatal("equal selections compared unequal")
	}
	if SameSelection(Selection{}, Selection{}) {
		t.Fatal("an empty kind compared equal to itself")
	}
}
