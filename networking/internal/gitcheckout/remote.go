package gitcheckout

import (
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

// RemoteName limits a remote record's name. A name becomes a git argument, so it
// is checked before it is ever used.
var remoteNamePattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9._-]{0,63}$`)

var (
	sshUserPattern     = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9._-]{0,63}$`)
	dnsLabelPattern    = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$`)
	repositorySegment  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)
	ipv4Pattern        = regexp.MustCompile(`^[0-9]{1,3}$`)
	bracketedIPv6      = regexp.MustCompile(`^\[[0-9a-fA-F:]+\]$`)
	scpPattern         = regexp.MustCompile(`^(?:([A-Za-z_][A-Za-z0-9._-]{0,63})@)?([^:@/]+):(.+)$`)
	numericPortPattern = regexp.MustCompile(`^[1-9][0-9]{0,4}$`)
)

// Identity is the transport identity of one remote: what it is compared by, and
// never what it is displayed as.
type Identity struct {
	Transport          string `json:"transport"`
	Host               string `json:"host"`
	EffectivePort      int    `json:"effectivePort"`
	SSHUser            string `json:"sshUser,omitempty"`
	RepositoryPathKind string `json:"repositoryPathKind"`
	RepositoryPath     string `json:"repositoryPath"`
	Display            string `json:"display"`
}

// Source is a validated remote as the user supplied it, safe to hand to git
// unchanged.
type Source struct {
	DeclaredURL string   `json:"declaredUrl"`
	Identity    Identity `json:"identity"`
}

// NamedRemote is one named remote with its separately validated source.
type NamedRemote struct {
	Name   string `json:"name"`
	Source Source `json:"source"`
}

const (
	transportHTTPS = "https"
	transportSSH   = "ssh"
	kindAbsolute   = "absolute"
	kindRelative   = "relative"
)

// ParseSource parses one production remote URL. A local path, a git helper
// (ext::), a URL carrying credentials, and any URL extras are refused: the
// launcher only ever clones over HTTPS or SSH, and it never stores a secret it
// was not given deliberately.
func ParseSource(value string) (Source, error) {
	if value == "" || len(value) > 2048 {
		return Source{}, fmt.Errorf("%w: Git remote URL is required.", ErrRemoteInvalid)
	}
	if unsupportedRemoteCharacter(value) {
		return Source{}, fmt.Errorf("%w: Git remote URL contains unsupported characters.", ErrRemoteInvalid)
	}
	for _, segment := range strings.Split(value, "/") {
		if segment == "." || segment == ".." {
			return Source{}, fmt.Errorf("%w: Git remote URL contains an ambiguous path segment.", ErrRemoteInvalid)
		}
	}
	if !strings.Contains(value, "://") {
		if identity, ok, err := parseSCPSyntax(value); ok {
			if err != nil {
				return Source{}, err
			}
			return Source{DeclaredURL: value, Identity: identity}, nil
		}
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme == "" {
		return Source{}, fmt.Errorf("%w: Git remote URL must use HTTPS or SSH.", ErrRemoteInvalid)
	}
	switch parsed.Scheme {
	case "https":
		identity, parseErr := parseHTTPS(parsed)
		if parseErr != nil {
			return Source{}, parseErr
		}
		return Source{DeclaredURL: value, Identity: identity}, nil
	case "ssh":
		identity, parseErr := parseSSHURL(parsed)
		if parseErr != nil {
			return Source{}, parseErr
		}
		return Source{DeclaredURL: value, Identity: identity}, nil
	}
	return Source{}, fmt.Errorf("%w: Git remote transport is not supported.", ErrRemoteInvalid)
}

// unsupportedRemoteCharacter refuses whitespace, control characters, a
// backslash, and the three characters that would make one URL parse as another
// (a percent escape, a fragment and a query).
func unsupportedRemoteCharacter(value string) bool {
	for _, character := range value {
		switch {
		case character <= 0x1f, unicode.IsSpace(character):
			return true
		case character == '\\', character == '%', character == '#', character == '?':
			return true
		}
	}
	return false
}

// AssertRemoteName validates a remote name before it becomes a git argument.
func AssertRemoteName(name string) error {
	if !remoteNamePattern.MatchString(name) || strings.HasPrefix(name, ".") {
		return fmt.Errorf("%w: Git remote name is invalid.", ErrRemoteInvalid)
	}
	return nil
}

// CreateNamedRemote checks the name and the URL independently, so a valid name
// cannot carry an unchecked URL into a command.
func CreateNamedRemote(name, declaredURL string) (NamedRemote, error) {
	if err := AssertRemoteName(name); err != nil {
		return NamedRemote{}, err
	}
	source, err := ParseSource(declaredURL)
	if err != nil {
		return NamedRemote{}, err
	}
	return NamedRemote{Name: name, Source: source}, nil
}

// AssertNamedRemote re-validates a persisted named remote the way the shell does:
// the source is re-parsed from its declared URL, and the stored identity must be
// exactly what that URL parses to, field for field. A record whose identity was
// edited, or whose optional SSH user gained or lost a value, is refused rather
// than trusted.
func AssertNamedRemote(remote NamedRemote) error {
	if err := AssertRemoteName(remote.Name); err != nil {
		return err
	}
	parsed, err := ParseSource(remote.Source.DeclaredURL)
	if err != nil {
		return err
	}
	identity := remote.Source.Identity
	if identity.Transport == "" || identity.Host == "" || identity.RepositoryPath == "" ||
		identity.RepositoryPathKind == "" || identity.Display == "" {
		return fmt.Errorf("%w: Git remote identity is invalid.", ErrRemoteInvalid)
	}
	if identity.EffectivePort <= 0 || identity.EffectivePort > 65535 {
		return fmt.Errorf("%w: Git remote identity is invalid.", ErrRemoteInvalid)
	}
	if !IdentitiesEqual(parsed.Identity, identity) || identity.Display != parsed.Identity.Display {
		return fmt.Errorf("%w: Git remote identity does not match its declared URL.", ErrRemoteInvalid)
	}
	return nil
}

// IdentitiesEqual compares transport identity rather than display text, so a git
// configuration rewrite or a different spelling of the same address cannot make
// two different remotes look alike.
func IdentitiesEqual(left, right Identity) bool {
	return left.Transport == right.Transport &&
		left.Host == right.Host &&
		left.EffectivePort == right.EffectivePort &&
		left.SSHUser == right.SSHUser &&
		left.RepositoryPathKind == right.RepositoryPathKind &&
		left.RepositoryPath == right.RepositoryPath
}

// AssertIdentity refuses an observed remote that differs from the confirmed
// source, and names both addresses so the operator can see what changed.
func AssertIdentity(expected, observed Identity) error {
	if IdentitiesEqual(expected, observed) {
		return nil
	}
	return fmt.Errorf(
		"%w: Observed Git remote does not match the selected source (expected %s, observed %s).",
		ErrRemoteMismatch, expected.Display, observed.Display,
	)
}

func parseHTTPS(parsed *url.URL) (Identity, error) {
	if parsed.User != nil || parsed.Fragment != "" || parsed.RawQuery != "" || parsed.Port() == "0" {
		return Identity{}, fmt.Errorf("%w: HTTPS Git remotes cannot carry credentials or URL extras.", ErrRemoteInvalid)
	}
	host, err := parseHost(hostnameOf(parsed))
	if err != nil {
		return Identity{}, err
	}
	port, err := parsePort(parsed.Port(), 443)
	if err != nil {
		return Identity{}, err
	}
	path, err := parseRepositoryPath(parsed.Path, kindAbsolute)
	if err != nil {
		return Identity{}, err
	}
	return Identity{
		Transport:          transportHTTPS,
		Host:               host,
		EffectivePort:      port,
		RepositoryPathKind: kindAbsolute,
		RepositoryPath:     path,
		Display:            "https://" + host + ":" + strconv.Itoa(port) + "/" + path,
	}, nil
}

func parseSSHURL(parsed *url.URL) (Identity, error) {
	password := ""
	user := ""
	if parsed.User != nil {
		user = parsed.User.Username()
		password, _ = parsed.User.Password()
	}
	if password != "" || parsed.Fragment != "" || parsed.RawQuery != "" || parsed.Port() == "0" {
		return Identity{}, fmt.Errorf("%w: SSH Git remote URL contains unsupported credentials or URL extras.", ErrRemoteInvalid)
	}
	if user != "" && !sshUserPattern.MatchString(user) {
		return Identity{}, fmt.Errorf("%w: SSH Git remote user is invalid.", ErrRemoteInvalid)
	}
	host, err := parseHost(hostnameOf(parsed))
	if err != nil {
		return Identity{}, err
	}
	port, err := parsePort(parsed.Port(), 22)
	if err != nil {
		return Identity{}, err
	}
	path, err := parseRepositoryPath(parsed.Path, kindAbsolute)
	if err != nil {
		return Identity{}, err
	}
	prefix := ""
	if user != "" {
		prefix = user + "@"
	}
	return Identity{
		Transport:          transportSSH,
		Host:               host,
		EffectivePort:      port,
		SSHUser:            user,
		RepositoryPathKind: kindAbsolute,
		RepositoryPath:     path,
		Display:            "ssh://" + prefix + host + ":" + strconv.Itoa(port) + "/" + path,
	}, nil
}

// parseSCPSyntax reads the scp-like form [user@]host:path. It reports whether the
// value has that shape at all, so a local path without a colon falls through to
// URL parsing and is refused there.
func parseSCPSyntax(value string) (Identity, bool, error) {
	matched := scpPattern.FindStringSubmatch(value)
	if matched == nil {
		return Identity{}, false, nil
	}
	user, hostText, pathText := matched[1], matched[2], matched[3]
	host, err := parseHost(hostText)
	if err != nil {
		return Identity{}, true, err
	}
	kind := kindRelative
	if strings.HasPrefix(pathText, "/") {
		kind = kindAbsolute
	}
	path, err := parseRepositoryPath(pathText, kind)
	if err != nil {
		return Identity{}, true, err
	}
	prefix := ""
	if user != "" {
		prefix = user + "@"
	}
	display := "ssh-scp://" + prefix + host + ":22:" + path
	if kind == kindAbsolute {
		display = "ssh://" + prefix + host + ":22/" + path
	}
	return Identity{
		Transport:          transportSSH,
		Host:               host,
		EffectivePort:      22,
		SSHUser:            user,
		RepositoryPathKind: kind,
		RepositoryPath:     path,
		Display:            display,
	}, true, nil
}

// hostnameOf reproduces the JavaScript URL parser's hostname, which keeps the
// brackets around an IPv6 literal where Go's Hostname strips them. The rules
// below are the shell's, and the shell's hostname carries the brackets.
func hostnameOf(parsed *url.URL) string {
	host := parsed.Hostname()
	if strings.Contains(host, ":") {
		return "[" + host + "]"
	}
	return host
}

// parseHost accepts a hostname, localhost, an IPv4 literal or a bracketed IPv6
// literal, and lower-cases it so two spellings of one host compare equal.
func parseHost(value string) (string, error) {
	host := strings.ToLower(value)
	if host == "" || len(host) > 253 || strings.Contains(host, "..") {
		return "", fmt.Errorf("%w: Git remote host is invalid.", ErrRemoteInvalid)
	}
	if host == "localhost" || isIPv4(host) || bracketedIPv6.MatchString(host) {
		return host, nil
	}
	for _, label := range strings.Split(host, ".") {
		if !dnsLabelPattern.MatchString(label) {
			return "", fmt.Errorf("%w: Git remote host is invalid.", ErrRemoteInvalid)
		}
	}
	return host, nil
}

func parsePort(value string, defaultPort int) (int, error) {
	if value == "" {
		return defaultPort, nil
	}
	if !numericPortPattern.MatchString(value) {
		return 0, fmt.Errorf("%w: Git remote port is invalid.", ErrRemoteInvalid)
	}
	port, err := strconv.Atoi(value)
	if err != nil || port > 65535 {
		return 0, fmt.Errorf("%w: Git remote port is invalid.", ErrRemoteInvalid)
	}
	return port, nil
}

// parseRepositoryPath strips the leading slash of an absolute path and then
// requires every segment to be a plain repository segment: no empty segment, no
// dot segment, and nothing that could be read as a git argument.
func parseRepositoryPath(value, kind string) (string, error) {
	path := value
	if kind == kindAbsolute {
		path = strings.TrimPrefix(path, "/")
	}
	if path == "" || len(path) > 1024 || strings.HasPrefix(path, "/") || strings.HasSuffix(path, "/") {
		return "", fmt.Errorf("%w: Git remote repository path is invalid.", ErrRemoteInvalid)
	}
	for _, segment := range strings.Split(path, "/") {
		if !repositorySegment.MatchString(segment) || segment == "." || segment == ".." {
			return "", fmt.Errorf("%w: Git remote repository path is invalid.", ErrRemoteInvalid)
		}
	}
	return path, nil
}

func isIPv4(value string) bool {
	parts := strings.Split(value, ".")
	if len(parts) != 4 {
		return false
	}
	for _, part := range parts {
		if !ipv4Pattern.MatchString(part) {
			return false
		}
		if len(part) > 1 && strings.HasPrefix(part, "0") {
			return false
		}
		number, err := strconv.Atoi(part)
		if err != nil || number > 255 {
			return false
		}
	}
	return true
}
