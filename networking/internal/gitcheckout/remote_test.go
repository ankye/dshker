package gitcheckout

import (
	"errors"
	"strings"
	"testing"
)

// TestParseSourceAcceptsTheTwoTransports pins the accepted forms and, just as
// importantly, the identity each one produces: the host is lower-cased, the
// default port is made explicit, and the display is the spelling the launcher
// shows back to the user.
func TestParseSourceAcceptsTheTwoTransports(t *testing.T) {
	cases := []struct {
		name  string
		value string
		want  Identity
	}{
		{
			name:  "https with the default port",
			value: "https://github.com/ankye/dshker.git",
			want: Identity{
				Transport:          transportHTTPS,
				Host:               "github.com",
				EffectivePort:      443,
				RepositoryPathKind: kindAbsolute,
				RepositoryPath:     "ankye/dshker.git",
				Display:            "https://github.com:443/ankye/dshker.git",
			},
		},
		{
			name:  "https with an explicit port and an upper-case host",
			value: "https://GitHub.example:8443/team/repo",
			want: Identity{
				Transport:          transportHTTPS,
				Host:               "github.example",
				EffectivePort:      8443,
				RepositoryPathKind: kindAbsolute,
				RepositoryPath:     "team/repo",
				Display:            "https://github.example:8443/team/repo",
			},
		},
		{
			name:  "ssh url with a user",
			value: "ssh://git@github.com/ankye/dshker.git",
			want: Identity{
				Transport:          transportSSH,
				Host:               "github.com",
				EffectivePort:      22,
				SSHUser:            "git",
				RepositoryPathKind: kindAbsolute,
				RepositoryPath:     "ankye/dshker.git",
				Display:            "ssh://git@github.com:22/ankye/dshker.git",
			},
		},
		{
			name:  "ssh url with a port and no user",
			value: "ssh://build.example:2222/srv/git/repo.git",
			want: Identity{
				Transport:          transportSSH,
				Host:               "build.example",
				EffectivePort:      2222,
				RepositoryPathKind: kindAbsolute,
				RepositoryPath:     "srv/git/repo.git",
				Display:            "ssh://build.example:2222/srv/git/repo.git",
			},
		},
		{
			name:  "scp syntax with a relative path",
			value: "git@github.com:ankye/dshker.git",
			want: Identity{
				Transport:          transportSSH,
				Host:               "github.com",
				EffectivePort:      22,
				SSHUser:            "git",
				RepositoryPathKind: kindRelative,
				RepositoryPath:     "ankye/dshker.git",
				Display:            "ssh-scp://git@github.com:22:ankye/dshker.git",
			},
		},
		{
			name:  "scp syntax with an absolute path",
			value: "build.example:/srv/git/repo.git",
			want: Identity{
				Transport:          transportSSH,
				Host:               "build.example",
				EffectivePort:      22,
				RepositoryPathKind: kindAbsolute,
				RepositoryPath:     "srv/git/repo.git",
				Display:            "ssh://build.example:22/srv/git/repo.git",
			},
		},
		{
			name:  "loopback https",
			value: "https://localhost:3080/team/repo",
			want: Identity{
				Transport:          transportHTTPS,
				Host:               "localhost",
				EffectivePort:      3080,
				RepositoryPathKind: kindAbsolute,
				RepositoryPath:     "team/repo",
				Display:            "https://localhost:3080/team/repo",
			},
		},
		{
			name:  "ipv4 literal",
			value: "ssh://192.168.1.10/srv/repo",
			want: Identity{
				Transport:          transportSSH,
				Host:               "192.168.1.10",
				EffectivePort:      22,
				RepositoryPathKind: kindAbsolute,
				RepositoryPath:     "srv/repo",
				Display:            "ssh://192.168.1.10:22/srv/repo",
			},
		},
		{
			name:  "ipv6 literal keeps its brackets",
			value: "ssh://[::1]/srv/repo",
			want: Identity{
				Transport:          transportSSH,
				Host:               "[::1]",
				EffectivePort:      22,
				RepositoryPathKind: kindAbsolute,
				RepositoryPath:     "srv/repo",
				Display:            "ssh://[::1]:22/srv/repo",
			},
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			source, err := ParseSource(testCase.value)
			if err != nil {
				t.Fatalf("parse: %v", err)
			}
			if source.DeclaredURL != testCase.value {
				t.Fatalf("declared url = %q", source.DeclaredURL)
			}
			if source.Identity != testCase.want {
				t.Fatalf("identity = %+v, want %+v", source.Identity, testCase.want)
			}
		})
	}
}

// TestParseSourceRefusesEverythingElse is the rule that keeps a credential, a
// local path and a helper out of the commands the core runs.
func TestParseSourceRefusesEverythingElse(t *testing.T) {
	values := []string{
		"",
		"/srv/git/repo",
		"./repo",
		"file:///srv/git/repo",
		"ftp://example.com/repo",
		"ext::sh -c whoami",
		"https://user:secret@github.com/ankye/dshker.git",
		"https://token@github.com/ankye/dshker.git",
		"https://github.com/ankye/dshker.git?ref=main",
		"https://github.com/ankye/dshker.git#fragment",
		"https://github.com/ankye/%2e%2e/dshker.git",
		"https://github.com//dshker.git",
		"https://github.com/ankye/../dshker.git",
		"https://github.com/ankye/dshker.git/",
		"https://github.com:0/ankye/dshker.git",
		"https://github.com:99999/ankye/dshker.git",
		"https://github.com:port/ankye/dshker.git",
		"ssh://bad user@github.com/ankye/dshker.git",
		"ssh://-bad@github.com/ankye/dshker.git",
		"ssh://git:secret@github.com/ankye/dshker.git",
		"https://h..x/ankye/dshker.git",
		"https://a.b-.c/ankye/dshker.git",
		"https://github.com/ankye/dsh ker.git",
		"https://github.com\\ankye\\dshker.git",
		"https://github.com/" + strings.Repeat("a", 1025),
		strings.Repeat("a", 2049),
	}
	for _, value := range values {
		if _, err := ParseSource(value); !errors.Is(err, ErrRemoteInvalid) {
			t.Errorf("ParseSource(%q) = %v, want git.remote_invalid", value, err)
		}
	}
}

// TestRemoteNames covers the name rules: a name becomes a git argument, so it is
// checked before it is used and cannot start with a dot or a digit.
func TestRemoteNames(t *testing.T) {
	for _, name := range []string{"origin", "upstream", "a", "Origin-2", "a.b_c-d"} {
		if err := AssertRemoteName(name); err != nil {
			t.Errorf("AssertRemoteName(%q) = %v", name, err)
		}
	}
	for _, name := range []string{"", ".hidden", "1origin", "-origin", "a b", "a/b", strings.Repeat("a", 65)} {
		if err := AssertRemoteName(name); !errors.Is(err, ErrRemoteInvalid) {
			t.Errorf("AssertRemoteName(%q) = %v, want git.remote_invalid", name, err)
		}
	}
	if _, err := CreateNamedRemote("origin", "https://github.com/ankye/dshker.git"); err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, err := CreateNamedRemote("origin", "/srv/repo"); !errors.Is(err, ErrRemoteInvalid) {
		t.Fatalf("create with a local path = %v", err)
	}
}

// TestAssertNamedRemoteRevalidatesTheRecord pins the persistence rule: a stored
// remote is not trusted, it is re-parsed and must still agree with its own
// declared URL, field for field.
func TestAssertNamedRemoteRevalidatesTheRecord(t *testing.T) {
	record, err := CreateNamedRemote("origin", "ssh://git@github.com/ankye/dshker.git")
	if err != nil {
		t.Fatal(err)
	}
	if err := AssertNamedRemote(record); err != nil {
		t.Fatalf("valid record = %v", err)
	}

	edited := record
	edited.Source.Identity.Host = "evil.example"
	if err := AssertNamedRemote(edited); !errors.Is(err, ErrRemoteInvalid) {
		t.Fatalf("edited host = %v", err)
	}

	droppedUser := record
	droppedUser.Source.Identity.SSHUser = ""
	if err := AssertNamedRemote(droppedUser); !errors.Is(err, ErrRemoteInvalid) {
		t.Fatalf("dropped ssh user = %v", err)
	}

	editedDisplay := record
	editedDisplay.Source.Identity.Display = "ssh://git@github.com:22/other"
	if err := AssertNamedRemote(editedDisplay); !errors.Is(err, ErrRemoteInvalid) {
		t.Fatalf("edited display = %v", err)
	}

	renamed := record
	renamed.Name = "1origin"
	if err := AssertNamedRemote(renamed); !errors.Is(err, ErrRemoteInvalid) {
		t.Fatalf("invalid name = %v", err)
	}
}

// TestIdentityComparisonIgnoresSpelling: two remotes that reach the same
// repository are equal even when their display differs, and two that do not are
// refused with both addresses named.
func TestIdentityComparisonIgnoresSpelling(t *testing.T) {
	withDefault, err := ParseSource("ssh://git@github.com/ankye/dshker.git")
	if err != nil {
		t.Fatal(err)
	}
	withExplicit, err := ParseSource("ssh://git@github.com:22/ankye/dshker.git")
	if err != nil {
		t.Fatal(err)
	}
	if !IdentitiesEqual(withDefault.Identity, withExplicit.Identity) {
		t.Fatal("the same address spelled two ways compared unequal")
	}

	other, err := ParseSource("ssh://git@github.com/ankye/other.git")
	if err != nil {
		t.Fatal(err)
	}
	err = AssertIdentity(withDefault.Identity, other.Identity)
	if !errors.Is(err, ErrRemoteMismatch) {
		t.Fatalf("mismatch = %v", err)
	}
	if !strings.Contains(err.Error(), "other.git") || !strings.Contains(err.Error(), "dshker.git") {
		t.Fatalf("mismatch does not name both addresses: %v", err)
	}
	if err := AssertIdentity(withDefault.Identity, withExplicit.Identity); err != nil {
		t.Fatalf("equal identities = %v", err)
	}
}
