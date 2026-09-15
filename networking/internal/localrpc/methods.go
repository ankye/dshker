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
	// The device catalog moved into the core in 3.6b. These are additive to the
	// version 1 table: the shell answers the same way it did while it owned the
	// file, and the revision it passes back is the same sha256 of the bytes.
	{"core.catalog_commit", RoleShell},
	{"core.catalog_enable", RoleShell},
	{"core.catalog_inspect", RoleShell},
	{"core.catalog_remove_service", RoleShell},
	// The managed installation catalog moved into the core in 4.2. Additive
	// within version 1, with the shell's own managed.* refusal codes.
	{"core.install_catalog_commit", RoleShell},
	{"core.install_catalog_inspect", RoleShell},
	// The managed-root registry moved into the core in 4.1. Additive within
	// version 1, and the refusal codes are the shell's own managed.* ones.
	{"core.roots_commit", RoleShell},
	{"core.roots_inspect", RoleShell},
	// The reverse-proxy binding moved with the DSH child in 6.1: a peer asks what
	// address this host serves, and a headless core answers from the child it
	// supervises. Additive within version 1.
	{"core.runtime_binding", RoleShell},
	{"core.secret_delete", RoleShell},
	{"core.secret_get", RoleShell},
	{"core.secret_set", RoleShell},
	// The shell has always called these two while enrolling a device; they were
	// missing from the table, which made the table an incomplete description of
	// the contract. Publishing them is additive within version 1.
	{"device.createCSR", RoleShell},
	{"device.createKey", RoleShell},
	{"device.enroll", RoleShell},
	{"device.enrollmentResult", RoleShell},
	{"device.enrollmentToken", RoleShell},
	{"device.restore", RoleShell},
	// The network directory moved into the core: it holds one snapshot per
	// service and announces changes, where every page used to read and cache its
	// own copy. Additive within version 1.
	{"directory.inspect", RoleShell},
	{"directory.refresh", RoleShell},
	{"devices.bind", RoleShell},
	{"devices.list", RoleShell},
	{"devices.unbind", RoleShell},
	{"network.invalidate", RoleShell},
	{"network.join", RoleShell},
	{"network.leave", RoleShell},
	// The checkout layer moved into the core in 4.2: the shell asks for one
	// operation and receives a verified identity it persists. Additive within
	// version 1, with the three managed.git_* codes the page already maps.
	{"managed.checkout_prepare", RoleShell},
	{"managed.checkout_verify", RoleShell},
	{"managed.git_register", RoleShell},
	{"managed.repository_inspect", RoleShell},
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
	// The SSH route moved into the core in 5.1. Additive within version 1, with
	// the shell's own remote.* refusal codes.
	{"remote.catalog_create", RoleShell},
	{"remote.catalog_inspect", RoleShell},
	{"remote.catalog_remove", RoleShell},
	{"remote.catalog_update", RoleShell},
	{"remote.broker_start", RoleShell},
	{"remote.broker_status", RoleShell},
	{"remote.broker_stop", RoleShell},
	{"remote.connect", RoleShell},
	{"remote.directory", RoleShell},
	{"remote.disconnect", RoleShell},
	{"remote.status", RoleShell},
	{"remote.roots", RoleShell},
	// The DSH Web child moved into the core in 4.3 to 4.5. These are additive
	// within version 1, answered by the core's own process supervision, and they
	// carry the shell's runtime.* refusal codes unchanged.
	{"runtime.console", RoleShell},
	{"runtime.invalidate", RoleShell},
	{"runtime.port_get", RoleShell},
	{"runtime.port_set", RoleShell},
	{"runtime.start", RoleShell},
	{"runtime.status", RoleShell},
	{"runtime.stop", RoleShell},
	{"service.configure", RoleShell},
	{"user.current", RoleShell},
	{"user.login", RoleShell},
	{"user.logout", RoleShell},
	{"user.register", RoleShell},
	{"peer.state", RoleParent},
	{"runtime.connect", RoleParent},
	// Sent when the core's directory snapshot for a service changes, so a shell
	// mirrors one maintained list instead of polling every list it renders.
	{"directory.changed", RoleParent},
	// Sent when the computers recorded for a service change, so the paired-computer
	// list follows the coordinator without a page having to ask for it.
	{"catalog.changed", RoleParent},
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
