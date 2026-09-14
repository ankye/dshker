package gitcheckout

import (
	"errors"
	"testing"
)

func TestParseVersionAcceptsWhatGitPrints(t *testing.T) {
	cases := []struct {
		value string
		want  Version
	}{
		{value: "git version 2.43.0\n", want: Version{Major: 2, Minor: 43, Patch: 0, Text: "2.43.0"}},
		{value: "git version 2.43.0", want: Version{Major: 2, Minor: 43, Patch: 0, Text: "2.43.0"}},
		{value: "git version 2.43.0\r\n", want: Version{Major: 2, Minor: 43, Patch: 0, Text: "2.43.0"}},
		{value: "git version 2.39.3 (Apple Git-145)\n", want: Version{Major: 2, Minor: 39, Patch: 3, Text: "2.39.3"}},
		{value: "git version 2.43.0.windows.1", want: Version{Major: 2, Minor: 43, Patch: 0, Text: "2.43.0"}},
		{value: "git version 2.43.0-rc1", want: Version{Major: 2, Minor: 43, Patch: 0, Text: "2.43.0"}},
		{value: "git version 10.0.7", want: Version{Major: 10, Minor: 0, Patch: 7, Text: "10.0.7"}},
	}
	for _, testCase := range cases {
		got, err := ParseVersion(testCase.value)
		if err != nil {
			t.Errorf("ParseVersion(%q) = %v", testCase.value, err)
			continue
		}
		if got != testCase.want {
			t.Errorf("ParseVersion(%q) = %+v, want %+v", testCase.value, got, testCase.want)
		}
	}
}

func TestParseVersionRefusesEverythingElse(t *testing.T) {
	values := []string{
		"",
		"2.43.0",
		"git version",
		"git version ",
		"git version 2.43",
		"git version 2",
		"git version 02.43.0",
		"git version 2.43.0\n2.44.0",
		"git version 2.43.0\nnot a version",
		"git version 2.43.0;rm -rf /",
		"git version x.y.z",
		"git version -1.0.0",
	}
	for _, value := range values {
		if _, err := ParseVersion(value); !errors.Is(err, ErrVersionInvalid) {
			t.Errorf("ParseVersion(%q) = %v, want git.version_invalid", value, err)
		}
	}
}

func TestVersionComparisonAndPolicy(t *testing.T) {
	minimum := Version{Major: 2, Minor: 30, Patch: 0, Text: "2.30.0"}
	maximum := Version{Major: 3, Minor: 0, Patch: 0, Text: "3.0.0"}
	policy := VersionPolicy{Minimum: minimum, MaximumExclusive: maximum}
	if err := AssertVersionPolicy(policy); err != nil {
		t.Fatalf("policy: %v", err)
	}
	if CompareVersions(minimum, maximum) >= 0 || CompareVersions(maximum, minimum) <= 0 {
		t.Fatal("comparison is not ordered")
	}
	if CompareVersions(minimum, minimum) != 0 {
		t.Fatal("a version did not compare equal to itself")
	}

	inside := Version{Major: 2, Minor: 43, Patch: 0, Text: "2.43.0"}
	if err := AssertVersionSupported(inside, policy); err != nil {
		t.Fatalf("supported version = %v", err)
	}
	below := Version{Major: 2, Minor: 29, Patch: 9, Text: "2.29.9"}
	if err := AssertVersionSupported(below, policy); !errors.Is(err, ErrVersionUnsupported) {
		t.Fatalf("below the minimum = %v", err)
	}
	if err := AssertVersionSupported(maximum, policy); !errors.Is(err, ErrVersionUnsupported) {
		t.Fatalf("the maximum itself = %v", err)
	}
	if err := AssertVersionPolicy(VersionPolicy{Minimum: maximum, MaximumExclusive: minimum}); !errors.Is(err, ErrVersionInvalid) {
		t.Fatalf("inverted policy = %v", err)
	}
	if err := AssertVersionPolicy(VersionPolicy{Minimum: minimum, MaximumExclusive: minimum}); !errors.Is(err, ErrVersionInvalid) {
		t.Fatalf("empty policy = %v", err)
	}
	if err := AssertVersion(Version{Major: 2, Minor: 43, Patch: 0, Text: "2.43"}, "subject"); !errors.Is(err, ErrVersionInvalid) {
		t.Fatal("a version whose text disagrees with its numbers was accepted")
	}
}
