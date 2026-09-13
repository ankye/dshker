package installcatalog

import (
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

// The remote shapes are the ones the Launcher already persisted, so a catalog
// either side wrote stays readable while ownership moves. Only HTTPS and SSH are
// accepted, and only in the exact spellings Git is later handed unchanged.

var (
	remoteNamePattern      = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9._-]{0,63}$`)
	sshUserPattern         = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9._-]{0,63}$`)
	dnsLabelPattern        = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)
	repositorySegment      = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)
	scpPattern             = regexp.MustCompile(`^(?:([A-Za-z_][A-Za-z0-9._-]{0,63})@)?([^:@/]+):(.+)$`)
	ipv4Part               = regexp.MustCompile(`^[0-9]{1,3}$`)
	bracketedIPv6          = regexp.MustCompile(`^\[[0-9a-f:]+\]$`)
	remoteUnsafeCharacters = regexp.MustCompile("[\\s\\x00-\\x1f\\\\]|[%#?]")
	ambiguousPathSegment   = regexp.MustCompile(`(?:^|/)\.{1,2}(?:/|$)`)
	portPattern            = regexp.MustCompile(`^[1-9][0-9]{0,4}$`)
)

// RemoteIdentity is the transport identity of one declared remote, compared
// instead of display text so a Git configuration rewrite cannot impersonate it.
type RemoteIdentity struct {
	Transport          string `json:"transport"`
	Host               string `json:"host"`
	EffectivePort      int64  `json:"effectivePort"`
	SSHUser            string `json:"sshUser,omitempty"`
	RepositoryPathKind string `json:"repositoryPathKind"`
	RepositoryPath     string `json:"repositoryPath"`
	Display            string `json:"display"`
}

// RemoteSource is a validated remote as the user supplied it.
type RemoteSource struct {
	DeclaredURL string         `json:"declaredUrl"`
	Identity    RemoteIdentity `json:"identity"`
}

// NamedRemote is one named remote with its separately validated source.
type NamedRemote struct {
	Name   string       `json:"name"`
	Source RemoteSource `json:"source"`
}

// ParseRemoteIdentity parses one production remote URL. Local paths and helpers
// are not remotes, and nothing is guessed: an unknown transport is refused.
func ParseRemoteIdentity(declared string) (RemoteIdentity, bool) {
	if declared == "" || len(declared) > 2048 || remoteUnsafeCharacters.MatchString(declared) {
		return RemoteIdentity{}, false
	}
	if ambiguousPathSegment.MatchString(declared) {
		return RemoteIdentity{}, false
	}
	if !strings.Contains(declared, "://") {
		return parseScpRemote(declared)
	}
	parsed, err := url.Parse(declared)
	if err != nil {
		return RemoteIdentity{}, false
	}
	switch parsed.Scheme {
	case "https":
		return parseHTTPSRemote(parsed)
	case "ssh":
		return parseSSHRemote(parsed)
	}
	return RemoteIdentity{}, false
}

func parseHTTPSRemote(value *url.URL) (RemoteIdentity, bool) {
	if value.User != nil || value.Fragment != "" || value.RawQuery != "" || value.Port() == "0" {
		return RemoteIdentity{}, false
	}
	host, ok := parseRemoteHost(value.Hostname())
	if !ok {
		return RemoteIdentity{}, false
	}
	port, ok := parseRemotePort(value.Port(), 443)
	if !ok {
		return RemoteIdentity{}, false
	}
	path, kind, ok := parseRepositoryPath(value.EscapedPath(), "absolute")
	if !ok {
		return RemoteIdentity{}, false
	}
	return RemoteIdentity{
		Transport:          "https",
		Host:               host,
		EffectivePort:      port,
		RepositoryPathKind: kind,
		RepositoryPath:     path,
		Display:            "https://" + host + ":" + strconv.FormatInt(port, 10) + "/" + path,
	}, true
}

func parseSSHRemote(value *url.URL) (RemoteIdentity, bool) {
	if value.User != nil && value.User.String() != "" {
		// The password half is refused even when a user name is present.
		if _, hasPassword := value.User.Password(); hasPassword {
			return RemoteIdentity{}, false
		}
	}
	if value.Fragment != "" || value.RawQuery != "" || value.Port() == "0" {
		return RemoteIdentity{}, false
	}
	user := ""
	if value.User != nil {
		user = value.User.Username()
		if !sshUserPattern.MatchString(user) {
			return RemoteIdentity{}, false
		}
	}
	host, ok := parseRemoteHost(value.Hostname())
	if !ok {
		return RemoteIdentity{}, false
	}
	port, ok := parseRemotePort(value.Port(), 22)
	if !ok {
		return RemoteIdentity{}, false
	}
	path, kind, ok := parseRepositoryPath(value.EscapedPath(), "absolute")
	if !ok {
		return RemoteIdentity{}, false
	}
	prefix := ""
	if user != "" {
		prefix = user + "@"
	}
	return RemoteIdentity{
		Transport:          "ssh",
		Host:               host,
		EffectivePort:      port,
		SSHUser:            user,
		RepositoryPathKind: kind,
		RepositoryPath:     path,
		Display:            "ssh://" + prefix + host + ":" + strconv.FormatInt(port, 10) + "/" + path,
	}, true
}

// parseScpRemote accepts the one scp-like spelling Git also understands, without
// treating it as a URL.
func parseScpRemote(declared string) (RemoteIdentity, bool) {
	match := scpPattern.FindStringSubmatch(declared)
	if match == nil {
		return RemoteIdentity{}, false
	}
	user, hostPart, pathPart := match[1], match[2], match[3]
	host, ok := parseRemoteHost(hostPart)
	if !ok {
		return RemoteIdentity{}, false
	}
	kind := "relative"
	if strings.HasPrefix(pathPart, "/") {
		kind = "absolute"
	}
	path, kind, ok := parseRepositoryPath(pathPart, kind)
	if !ok {
		return RemoteIdentity{}, false
	}
	prefix := ""
	if user != "" {
		prefix = user + "@"
	}
	display := "ssh-scp://" + prefix + host + ":22:" + path
	if kind == "absolute" {
		display = "ssh://" + prefix + host + ":22/" + path
	}
	return RemoteIdentity{
		Transport:          "ssh",
		Host:               host,
		EffectivePort:      22,
		SSHUser:            user,
		RepositoryPathKind: kind,
		RepositoryPath:     path,
		Display:            display,
	}, true
}

func parseRemoteHost(value string) (string, bool) {
	host := strings.ToLower(value)
	if host == "" || len(host) > 253 || strings.Contains(host, "..") {
		return "", false
	}
	if host == "localhost" || isIPv4(host) || bracketedIPv6.MatchString(host) {
		return host, true
	}
	for _, label := range strings.Split(host, ".") {
		if !dnsLabelPattern.MatchString(label) {
			return "", false
		}
	}
	return host, true
}

func parseRemotePort(value string, fallback int64) (int64, bool) {
	if value == "" {
		return fallback, true
	}
	if !portPattern.MatchString(value) {
		return 0, false
	}
	port, err := strconv.ParseInt(value, 10, 64)
	if err != nil || port > 65535 {
		return 0, false
	}
	return port, true
}

func parseRepositoryPath(value, kind string) (string, string, bool) {
	path := value
	if kind == "absolute" {
		path = strings.TrimPrefix(value, "/")
	}
	if path == "" || len(path) > 1024 || strings.HasPrefix(path, "/") || strings.HasSuffix(path, "/") {
		return "", "", false
	}
	for _, segment := range strings.Split(path, "/") {
		if segment == "." || segment == ".." || !repositorySegment.MatchString(segment) {
			return "", "", false
		}
	}
	return path, kind, true
}

func isIPv4(value string) bool {
	parts := strings.Split(value, ".")
	if len(parts) != 4 {
		return false
	}
	for _, part := range parts {
		if !ipv4Part.MatchString(part) {
			return false
		}
		if len(part) > 1 && part[0] == '0' {
			return false
		}
		number, err := strconv.Atoi(part)
		if err != nil || number > 255 {
			return false
		}
	}
	return true
}

// remoteIdentitiesEqual compares transport identity only.
func remoteIdentitiesEqual(left, right RemoteIdentity) bool {
	return left.Transport == right.Transport &&
		left.Host == right.Host &&
		left.EffectivePort == right.EffectivePort &&
		left.SSHUser == right.SSHUser &&
		left.RepositoryPathKind == right.RepositoryPathKind &&
		left.RepositoryPath == right.RepositoryPath
}
