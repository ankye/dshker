package localrpc

import "strings"

// MethodTableVersion is the published version of Methods. Adding a method is
// additive within a version; changing a payload shape or a refusal code for an
// existing method needs a new version and a shell and core released together.
const MethodTableVersion = 1

// MaxMethodBytes is the frame reader's limit on the method field.
const MaxMethodBytes = 80

// MethodRole names the sender of a request.
type MethodRole string

const (
	// RoleShell marks a request the shell sends and the core answers.
	RoleShell MethodRole = "shell"
	// RoleParent marks a callback the core sends and the shell answers.
	RoleParent MethodRole = "parent"
)

// Method is one entry of the published method table.
type Method struct {
	Name string
	Role MethodRole
}

// Methods is the version 1 method table of the shell/core channel. It is the
// contract frozen by networking/docs/shell-core-protocol.md and is verified
// against the shipped dispatch by methods_test.go.
var Methods = []Method{
	{"core.version", RoleShell},
	{"core.secret_delete", RoleShell},
	{"core.secret_get", RoleShell},
	{"core.secret_set", RoleShell},
	{"device.enroll", RoleShell},
	{"device.enrollmentResult", RoleShell},
	{"device.enrollmentToken", RoleShell},
	{"device.restore", RoleShell},
	{"devices.bind", RoleShell},
	{"devices.list", RoleShell},
	{"devices.unbind", RoleShell},
	{"network.invalidate", RoleShell},
	{"network.join", RoleShell},
	{"network.leave", RoleShell},
	{"networks.create", RoleShell},
	{"networks.delete", RoleShell},
	{"networks.deletePair", RoleShell},
	{"networks.devices", RoleShell},
	{"networks.limit", RoleShell},
	{"networks.list", RoleShell},
	{"networks.pairs", RoleShell},
	{"networks.rename", RoleShell},
	{"pairs.action", RoleShell},
	{"pairs.adopt", RoleShell},
	{"pairs.identity", RoleShell},
	{"pairs.invite", RoleShell},
	{"pairs.list", RoleShell},
	{"pairs.pin", RoleShell},
	{"pairs.share", RoleShell},
	{"peer.connect", RoleShell},
	{"peer.disconnect", RoleShell},
	{"remote.directory", RoleShell},
	{"remote.roots", RoleShell},
	{"runtime.invalidate", RoleShell},
	{"service.configure", RoleShell},
	{"user.current", RoleShell},
	{"user.login", RoleShell},
	{"user.logout", RoleShell},
	{"user.register", RoleShell},
	{"peer.state", RoleParent},
	{"runtime.connect", RoleParent},
}

// Lookup reports the table entry for a method name.
func Lookup(name string) (Method, bool) {
	for _, method := range Methods {
		if method.Name == name {
			return method, true
		}
	}
	return Method{}, false
}

// ValidMethodName reports whether a name is a well-formed public method name.
func ValidMethodName(name string) bool {
	if name == "" || len(name) > MaxMethodBytes || strings.HasPrefix(name, ".") || strings.HasSuffix(name, ".") || strings.Contains(name, "..") {
		return false
	}
	for _, c := range name {
		if (c < 'a' || c > 'z') && (c < 'A' || c > 'Z') && (c < '0' || c > '9') && c != '.' && c != '_' {
			return false
		}
	}
	return strings.Contains(name, ".")
}
