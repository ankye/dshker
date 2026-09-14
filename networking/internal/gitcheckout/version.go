package gitcheckout

import (
	"fmt"
	"strconv"
	"strings"
)

// Version is a parsed three-component git version.
type Version struct {
	Major int    `json:"major"`
	Minor int    `json:"minor"`
	Patch int    `json:"patch"`
	Text  string `json:"text"`
}

// VersionPolicy is the comparison floor a launcher release declares rather than
// infers: a minimum, and a maximum that is itself excluded.
type VersionPolicy struct {
	Minimum          Version `json:"minimum"`
	MaximumExclusive Version `json:"maximumExclusive"`
}

// ParseVersion reads the line "git --version" prints. The three components must
// be plain decimal numbers with no leading zero, and anything after them must be
// introduced by a space, a dot or a dash — which is how a distribution build
// appends its own suffix, and what tells a version string apart from noise.
func ParseVersion(value string) (Version, error) {
	trimmed := strings.TrimRight(value, "\r\n")
	rest, found := strings.CutPrefix(trimmed, "git version ")
	if !found {
		return Version{}, fmt.Errorf("%w: Git version output is invalid.", ErrVersionInvalid)
	}
	// The three components are read one at a time, so a fourth dot belongs to the
	// suffix: "2.43.0.windows.1" is version 2.43.0 built by the Git for Windows
	// release, not a four-component version.
	at := 0
	components := make([]int, 0, 3)
	for index := 0; index < 3; index++ {
		if index > 0 {
			if at >= len(rest) || rest[at] != '.' {
				return Version{}, fmt.Errorf("%w: Git version output is invalid.", ErrVersionInvalid)
			}
			at++
		}
		start := at
		for at < len(rest) && rest[at] >= '0' && rest[at] <= '9' {
			at++
		}
		part := rest[start:at]
		if part == "" || (len(part) > 1 && part[0] == '0') {
			return Version{}, fmt.Errorf("%w: Git version output is invalid.", ErrVersionInvalid)
		}
		number, err := strconv.Atoi(part)
		if err != nil || number < 0 {
			return Version{}, fmt.Errorf("%w: Git version output is invalid.", ErrVersionInvalid)
		}
		components = append(components, number)
	}
	suffix := rest[at:]
	if suffix != "" && suffix[0] != ' ' && suffix[0] != '.' && suffix[0] != '-' {
		return Version{}, fmt.Errorf("%w: Git version output is invalid.", ErrVersionInvalid)
	}
	if strings.ContainsAny(suffix, "\r\n") {
		return Version{}, fmt.Errorf("%w: Git version output is invalid.", ErrVersionInvalid)
	}
	return Version{
		Major: components[0],
		Minor: components[1],
		Patch: components[2],
		Text:  fmt.Sprintf("%d.%d.%d", components[0], components[1], components[2]),
	}, nil
}

// CompareVersions orders two versions; only the three numbers take part, so a
// distribution suffix never decides a comparison.
func CompareVersions(left, right Version) int {
	if left.Major != right.Major {
		return left.Major - right.Major
	}
	if left.Minor != right.Minor {
		return left.Minor - right.Minor
	}
	return left.Patch - right.Patch
}

// AssertVersion refuses a version record whose numbers and text disagree, so a
// persisted version cannot be half-updated.
func AssertVersion(value Version, subject string) error {
	if value.Major < 0 || value.Minor < 0 || value.Patch < 0 {
		return fmt.Errorf("%w: %s is invalid.", ErrVersionInvalid, subject)
	}
	if value.Text != fmt.Sprintf("%d.%d.%d", value.Major, value.Minor, value.Patch) {
		return fmt.Errorf("%w: %s is invalid.", ErrVersionInvalid, subject)
	}
	return nil
}

// AssertVersionPolicy refuses a policy whose range is empty or inverted.
func AssertVersionPolicy(policy VersionPolicy) error {
	if err := AssertVersion(policy.Minimum, "Git minimum version"); err != nil {
		return err
	}
	if err := AssertVersion(policy.MaximumExclusive, "Git maximum version"); err != nil {
		return err
	}
	if CompareVersions(policy.Minimum, policy.MaximumExclusive) >= 0 {
		return fmt.Errorf("%w: Git version policy range is invalid.", ErrVersionInvalid)
	}
	return nil
}

// AssertVersionSupported applies the policy to an observed version, naming both
// what was found and what was required.
func AssertVersionSupported(observed Version, policy VersionPolicy) error {
	if err := AssertVersionPolicy(policy); err != nil {
		return err
	}
	if CompareVersions(observed, policy.Minimum) < 0 {
		return fmt.Errorf("%w: Registered Git version is below the required minimum (observed %s, required %s).", ErrVersionUnsupported, observed.Text, policy.Minimum.Text)
	}
	if CompareVersions(observed, policy.MaximumExclusive) >= 0 {
		return fmt.Errorf("%w: Registered Git version is above the required maximum (observed %s, required <%s).", ErrVersionUnsupported, observed.Text, policy.MaximumExclusive.Text)
	}
	return nil
}
