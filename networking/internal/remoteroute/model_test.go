package remoteroute

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

func computer() Computer { return Computer{Host: "build.example", Port: 2222, User: "deploy"} }

// TestBuildArgumentsMatchTheShell pins the exact argument order both OpenSSH
// clients are given, because a reordered option is a different connection.
func TestBuildArgumentsMatchTheShell(t *testing.T) {
	// The destination is the platform's own path spelling: scp receives whatever
	// the core resolved, and a Windows destination is not a POSIX path.
	destination := filepath.Join("route", "remote-peer.json")
	scp := BuildScpArguments(computer(), destination)
	wantScp := "-q -B -o StrictHostKeyChecking=yes -P 2222 deploy@build.example:.dshlauncher/remote-peer.json " + destination
	if strings.Join(scp, " ") != wantScp {
		t.Fatalf("scp = %v", scp)
	}
	forward := BuildSshForwardArguments(computer(), 51000, 3088)
	wantForward := "-N -T -o BatchMode=yes -o ExitOnForwardFailure=yes -o StrictHostKeyChecking=yes -p 2222 -L 127.0.0.1:51000:127.0.0.1:3088 deploy@build.example"
	if strings.Join(forward, " ") != wantForward {
		t.Fatalf("ssh = %v", forward)
	}
}

func TestResolveExecutablesMatchesThePlatforms(t *testing.T) {
	mac := ResolveExecutables("darwin")
	if mac.SSH != "/usr/bin/ssh" || mac.SCP != "/usr/bin/scp" {
		t.Fatalf("darwin = %+v", mac)
	}
	windows := ResolveExecutables("windows")
	if windows.SSH != "ssh.exe" || windows.SCP != "scp.exe" {
		t.Fatalf("windows = %+v", windows)
	}
}

func TestAssertComputerRefusesAnythingElse(t *testing.T) {
	for name, value := range map[string]Computer{
		"no host":        {Port: 22, User: "deploy"},
		"no user":        {Host: "build.example", Port: 22},
		"a port in host": {Host: "build.example:22", Port: 22, User: "deploy"},
		"a user in host": {Host: "deploy@build.example", Port: 22, User: "deploy"},
		"no port":        {Host: "build.example", User: "deploy"},
		"a huge port":    {Host: "build.example", Port: 70000, User: "deploy"},
	} {
		t.Run(name, func(t *testing.T) {
			if err := AssertComputer(value); !errors.Is(err, ErrInputInvalid) {
				t.Fatalf("%s = %v", name, err)
			}
		})
	}
}

// TestParseDescriptorIsStrict covers the document that names the port and secret
// this route will trust.
func TestParseDescriptorIsStrict(t *testing.T) {
	valid := `{"format":"dsh-launcher.remote-peer","version":1,"instanceId":"peer-1","port":3088,"secret":"s3cret"}`
	descriptor, err := ParseDescriptor([]byte(valid))
	if err != nil || descriptor.Port != 3088 || descriptor.Secret != "s3cret" {
		t.Fatalf("descriptor = %+v, %v", descriptor, err)
	}
	for name, document := range map[string]string{
		"not json":        "{",
		"an array":        "[]",
		"a missing field": `{"format":"dsh-launcher.remote-peer","version":1,"instanceId":"peer-1","port":3088}`,
		"an extra field":  `{"format":"dsh-launcher.remote-peer","version":1,"instanceId":"peer-1","port":3088,"secret":"s","extra":1}`,
		"another format":  `{"format":"other","version":1,"instanceId":"peer-1","port":3088,"secret":"s"}`,
		"another version": `{"format":"dsh-launcher.remote-peer","version":2,"instanceId":"peer-1","port":3088,"secret":"s"}`,
		"no instance":     `{"format":"dsh-launcher.remote-peer","version":1,"instanceId":"","port":3088,"secret":"s"}`,
		"no secret":       `{"format":"dsh-launcher.remote-peer","version":1,"instanceId":"peer-1","port":3088,"secret":""}`,
		"a bad port":      `{"format":"dsh-launcher.remote-peer","version":1,"instanceId":"peer-1","port":0,"secret":"s"}`,
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := ParseDescriptor([]byte(document)); !errors.Is(err, ErrPeerProtocolInvalid) {
				t.Fatalf("%s = %v", name, err)
			}
		})
	}
}

// TestParseRuntimeURLAcceptsOnlyExplicitLoopback is the invariant that keeps the
// session on the machine: a peer that answers with any other address is refused.
func TestParseRuntimeURLAcceptsOnlyExplicitLoopback(t *testing.T) {
	accepted := map[string]int{
		"http://127.0.0.1:3088/":           3088,
		"http://localhost:3088/?token=abc": 3088,
		"https://[::1]:4443/":              4443,
	}
	for value, port := range accepted {
		parsed, reported, err := ParseRuntimeURL(value)
		if err != nil || reported != port || parsed == "" {
			t.Errorf("%s = %q, %d, %v", value, parsed, reported, err)
		}
	}
	refused := []string{
		"http://192.168.1.9:3088/",
		"http://build.example:3088/",
		"http://127.0.0.1/",
		"file:///tmp/dsh",
		"not-a-url",
		"http://127.0.0.1:0/",
	}
	for _, value := range refused {
		if parsed, _, err := ParseRuntimeURL(value); !errors.Is(err, ErrPeerProtocolInvalid) {
			t.Errorf("%s was accepted as %q", value, parsed)
		}
	}
}

func TestMapLoopbackMovesTheAddressOntoTheForward(t *testing.T) {
	mapped, err := MapLoopback("http://127.0.0.1:3088/?token=abc", 51000)
	if err != nil || mapped != "http://127.0.0.1:51000/?token=abc" {
		t.Fatalf("mapped = %q, %v", mapped, err)
	}
}

func TestClassifySSHFailureSeparatesAuthentication(t *testing.T) {
	for _, diagnostic := range []string{
		"deploy@build.example: Permission denied (publickey).",
		"Authentication failed.",
		"Host key verification failed.",
	} {
		if err := ClassifySSHFailure(diagnostic); !errors.Is(err, ErrAuthenticationFailed) {
			t.Errorf("%q = %v", diagnostic, err)
		}
	}
	if err := ClassifySSHFailure("Connection timed out"); err != nil {
		t.Fatalf("a timeout = %v", err)
	}
}

func TestClassifyRuntimeResponseRequiresBothFields(t *testing.T) {
	value, err := ClassifyRuntimeResponse(`{"version":1,"url":"http://127.0.0.1:3088/"}`)
	if err != nil || value != "http://127.0.0.1:3088/" {
		t.Fatalf("response = %q, %v", value, err)
	}
	for name, body := range map[string]string{
		"an extra field":   `{"version":1,"url":"http://127.0.0.1:3088/","extra":1}`,
		"a missing field":  `{"version":1}`,
		"another version":  `{"version":2,"url":"http://127.0.0.1:3088/"}`,
		"a non string url": `{"version":1,"url":5}`,
		"not json":         "broker",
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := ClassifyRuntimeResponse(body); !errors.Is(err, ErrPeerProtocolInvalid) {
				t.Fatalf("%s = %v", name, err)
			}
		})
	}
}
