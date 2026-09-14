package main

// The headless command surface: `dshkerd serve` runs the core for a machine with
// no desktop session, and the named commands are clients of it over the same
// private endpoint the shell uses. Every command is a real answer from the same
// method table, so a headless host is operated the way the shell operates it.
import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/ankye/dshker/networking/internal/catalog"
	"github.com/ankye/dshker/networking/internal/core"
	"github.com/ankye/dshker/networking/internal/harnessruntime"
	"github.com/ankye/dshker/networking/internal/helper"
	"github.com/ankye/dshker/networking/internal/localrpc"
	"github.com/ankye/dshker/networking/internal/peerbroker"
	"github.com/ankye/dshker/networking/internal/remoteroute"
	"github.com/ankye/dshker/networking/internal/rootregistry"
	"github.com/ankye/dshker/networking/internal/secret"
)

// HeadlessSubject is the launch subject the CLI owns. The launcher uses its own,
// so a desktop and a headless core never fight over one child.
const HeadlessSubject = "dshkerd-dsh"

// cliCommands are the subcommands this binary answers. Anything else is the
// parent-driven mode the shell starts, which stays the default so an existing
// shell keeps working unchanged.
var cliCommands = map[string]bool{
	"serve":   true,
	"status":  true,
	"roots":   true,
	"dsh":     true,
	"call":    true,
	"pair":    true,
	"connect": true,
	"help":    true,
}

// isCommand reports whether the first argument names a CLI subcommand.
func isCommand(argument string) bool { return cliCommands[argument] }

// runCLI runs one headless command and returns the process exit code.
func runCLI(args []string, stdout io.Writer, stderr io.Writer) int {
	switch args[0] {
	case "serve":
		return runServe(args[1:], stdout, stderr)
	case "status":
		return runStatus(args[1:], stdout, stderr)
	case "roots":
		return runRoots(args[1:], stdout, stderr)
	case "dsh":
		return runDsh(args[1:], stdout, stderr)
	case "call":
		return runCall(args[1:], stdout, stderr)
	case "pair":
		return runPair(args[1:], stdout, stderr)
	case "connect":
		return runConnect(args[1:], stdout, stderr)
	default:
		writeUsage(stdout)
		return 0
	}
}

func writeUsage(stdout io.Writer) {
	fmt.Fprintln(stdout, "dshkerd <command>")
	fmt.Fprintln(stdout, "  serve  [--state D] [--data D] [--catalog D] [--roots PEM]")
	fmt.Fprintln(stdout, "  status [--state D] [--json]")
	fmt.Fprintln(stdout, "  roots  --registry FILE --native-home DIR [--state D] [--json]")
	fmt.Fprintln(stdout, "  dsh start --directory DIR --pnpm FILE [--pnpm-prefix A] [--patch FILE] [--port N] [--state D]")
	fmt.Fprintln(stdout, "  dsh stop [--state D]")
	fmt.Fprintln(stdout, "  call   <method> [json|-] [--state D]")
	fmt.Fprintln(stdout, "  pair   --service ID [--share NETWORK] [--invite CODE --network NETWORK] [--state D]")
	fmt.Fprintln(stdout, "  connect --service ID --pair ID [--generation N] [--disconnect] [--state D]")
	fmt.Fprintln(stdout, "With no command, dshkerd is the child of the shell and bootstraps from stdin.")
}

// stateRoot resolves the per-user directory the endpoint record lives in.
func stateRoot(flagValue string) (string, error) {
	if flagValue != "" {
		return flagValue, nil
	}
	if environment := os.Getenv("DSHKER_STATE_DIR"); environment != "" {
		return environment, nil
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return "", errors.New("p2p.helper_configuration_required")
	}
	return filepath.Join(home, ".dshkerd"), nil
}

// endpointFor returns the private endpoint this state directory serves.
func endpointFor(state string) (string, error) {
	if os.PathSeparator == 92 {
		value := make([]byte, 16)
		if _, err := rand.Read(value); err != nil {
			return "", errors.New("p2p.helper_listen_failed")
		}
		return `\\.\pipe\dshker-peer-` + hex.EncodeToString(value), nil
	}
	return filepath.Join(state, "peer.sock"), nil
}

// openEndpointRecord reads the published record for one state directory.
func openEndpointRecord(state string) (localrpc.Bootstrap, error) {
	return localrpc.ReadEndpointRecord(filepath.Join(state, localrpc.EndpointFileName))
}

// clientFor connects to a running headless core.
func clientFor(ctx context.Context, state string) (*localrpc.Peer, func(), error) {
	record, err := openEndpointRecord(state)
	if err != nil {
		return nil, nil, err
	}
	conn, err := localrpc.Connect(ctx, record.Socket, record.Secret)
	if err != nil {
		return nil, nil, err
	}
	peer := localrpc.New(ctx, conn, func(context.Context, string, json.RawMessage) (any, error) {
		return nil, errors.New("p2p.invalid_operation")
	})
	return peer, func() { peer.Close() }, nil
}

// headlessMain answers the parent callbacks a core can send.
type headlessMain struct{}

func (headlessMain) Call(_ context.Context, method string, _ any) (json.RawMessage, error) {
	switch method {
	case "peer.state":
		// A headless host has no renderer to inform. The state is still real, and
		// it is what the next `status` call reads.
		return json.RawMessage("{}"), nil
	case "runtime.connect":
		// The remote asked this host to own its runtime. A headless core can only
		// answer that once a child has been started for it, so it refuses by name
		// rather than pretending to have one.
		return nil, errors.New("p2p.runtime_unavailable")
	}
	return nil, errors.New("p2p.invalid_operation")
}

// runServe runs the core with no parent: it publishes its own endpoint and
// answers every client that authenticates against it until the process is asked
// to stop.
func runServe(args []string, stdout io.Writer, stderr io.Writer) int {
	flags := flag.NewFlagSet("serve", flag.ContinueOnError)
	flags.SetOutput(stderr)
	state := flags.String("state", "", "per-user state directory")
	dataRoot := flags.String("data", "", "credential store root")
	catalogRoot := flags.String("catalog", "", "device catalog directory")
	rootsPath := flags.String("roots", "", "extra CA certificates in PEM form")
	if flags.Parse(args) != nil {
		return 2
	}
	directory, err := stateRoot(*state)
	if err != nil {
		return fail(stderr, err)
	}
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return fail(stderr, errors.New("p2p.insecure_socket_directory"))
	}
	if os.PathSeparator != 92 {
		// The listener refuses a directory anyone else can reach.
		if err := os.Chmod(directory, 0o700); err != nil {
			return fail(stderr, errors.New("p2p.insecure_socket_directory"))
		}
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	server := core.Serve{}
	if *dataRoot != "" {
		store, err := secretStoreFor(secret.Open, *dataRoot)
		if err != nil {
			return fail(stderr, err)
		}
		server.Store = store
	}
	if *catalogRoot != "" {
		store, err := catalog.Open(*catalogRoot)
		if err != nil {
			return fail(stderr, err)
		}
		server.Catalog = store
	}
	supervisor := harnessruntime.NewSupervisor()
	defer supervisor.Shutdown()
	server.Runtime = supervisor
	remoteRoute := remoteroute.NewRoute()
	defer remoteRoute.Shutdown()
	server.Remote = remoteRoute
	brokers := &peerbroker.Holder{}
	defer brokers.Shutdown()
	server.Brokers = brokers
	host := helper.New(ctx)
	defer host.Close()
	if *rootsPath != "" {
		roots, err := loadRoots(*rootsPath)
		if err != nil {
			return fail(stderr, err)
		}
		host.SetRoots(roots)
	}
	host.BindMain(headlessMain{})
	server.Peer = host

	endpoint, err := endpointFor(directory)
	if err != nil {
		return fail(stderr, err)
	}
	secretValue, err := localrpc.NewSecret()
	if err != nil {
		return fail(stderr, err)
	}
	listener, err := localrpc.Listen(endpoint)
	if err != nil {
		return fail(stderr, err)
	}
	defer listener.Close()
	recordPath := filepath.Join(directory, localrpc.EndpointFileName)
	if err := localrpc.WriteEndpointRecord(recordPath, localrpc.Bootstrap{
		Version: 1, Socket: endpoint, Secret: secretValue,
	}); err != nil {
		return fail(stderr, err)
	}
	readiness, err := json.Marshal(struct {
		Version int    `json:"version"`
		Serving bool   `json:"serving"`
		Socket  string `json:"socket"`
	}{1, true, endpoint})
	if err != nil {
		return fail(stderr, err)
	}
	if _, err := fmt.Fprintf(stdout, "%s\n", readiness); err != nil {
		return fail(stderr, err)
	}
	go func() { <-ctx.Done(); listener.Close() }()
	if err := localrpc.ServeEndpoint(ctx, listener, secretValue, func(callCtx context.Context, method string, payload json.RawMessage) (any, error) {
		return server.Handle(callCtx, method, payload)
	}); err != nil {
		return fail(stderr, err)
	}
	return 0
}

// runStatus reports the core table and the headless runtime in one answer.
func runStatus(args []string, stdout io.Writer, stderr io.Writer) int {
	flags := flag.NewFlagSet("status", flag.ContinueOnError)
	flags.SetOutput(stderr)
	state := flags.String("state", "", "per-user state directory")
	asJSON := flags.Bool("json", false, "print the raw answers")
	if flags.Parse(args) != nil {
		return 2
	}
	directory, err := stateRoot(*state)
	if err != nil {
		return fail(stderr, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	client, closeClient, err := clientFor(ctx, directory)
	if err != nil {
		return fail(stderr, err)
	}
	defer closeClient()
	version, err := client.Call(ctx, "core.version", struct{}{})
	if err != nil {
		return fail(stderr, err)
	}
	launch, launchErr := client.Call(ctx, "runtime.status", struct {
		SubjectID string `json:"subjectId"`
	}{HeadlessSubject})
	if *asJSON {
		return printJSON(stdout, stderr, map[string]json.RawMessage{
			"version": version,
			"launch":  launch,
		})
	}
	var table struct {
		Version int      `json:"version"`
		Methods []string `json:"methods"`
	}
	if json.Unmarshal(version, &table) != nil {
		return fail(stderr, errors.New("p2p.invalid_result"))
	}
	fmt.Fprintf(stdout, "core version %d, %d methods\n", table.Version, len(table.Methods))
	if launchErr != nil {
		fmt.Fprintf(stdout, "dsh web: %s\n", launchErr.Error())
	} else {
		fmt.Fprintf(stdout, "dsh web: %s\n", strings.TrimSpace(string(launch)))
	}
	return 0
}

// runRoots prints the managed roots the core reads, which is the same document
// the shell reads: one writer, two readers.
func runRoots(args []string, stdout io.Writer, stderr io.Writer) int {
	flags := flag.NewFlagSet("roots", flag.ContinueOnError)
	flags.SetOutput(stderr)
	state := flags.String("state", "", "per-user state directory")
	registry := flags.String("registry", "", "managed-root-registry.json")
	nativeHome := flags.String("native-home", "", "the Harness home of this machine")
	asJSON := flags.Bool("json", false, "print the raw answer")
	if flags.Parse(args) != nil {
		return 2
	}
	if *registry == "" || *nativeHome == "" {
		return fail(stderr, errors.New("p2p.invalid_arguments"))
	}
	directory, err := stateRoot(*state)
	if err != nil {
		return fail(stderr, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	client, closeClient, err := clientFor(ctx, directory)
	if err != nil {
		return fail(stderr, err)
	}
	defer closeClient()
	answer, err := client.Call(ctx, "core.roots_inspect", struct {
		FilePath      string `json:"filePath"`
		NativeDshHome string `json:"nativeDshHome"`
	}{*registry, *nativeHome})
	if err != nil {
		return fail(stderr, err)
	}
	if *asJSON {
		if _, err := fmt.Fprintf(stdout, "%s\n", answer); err != nil {
			return fail(stderr, err)
		}
		return 0
	}
	var envelope struct {
		Registry rootregistry.Registry `json:"registry"`
	}
	if json.Unmarshal(answer, &envelope) != nil {
		return fail(stderr, errors.New("p2p.invalid_result"))
	}
	for _, root := range envelope.Registry.Roots {
		fmt.Fprintf(stdout, "%s\t%s\t%s\n", root.Kind, root.RootID, root.CanonicalPath)
	}
	for _, workspace := range envelope.Registry.Workspaces {
		fmt.Fprintf(stdout, "workspace\t%s\t%s\n", workspace.WorkspaceID, workspace.WorkingDirectoryCanonicalPath)
	}
	return 0
}

// runDsh starts and stops the headless DSH Web child through the core.
func runDsh(args []string, stdout io.Writer, stderr io.Writer) int {
	if len(args) == 0 {
		return fail(stderr, errors.New("p2p.invalid_arguments"))
	}
	switch args[0] {
	case "start":
		return runDshStart(args[1:], stdout, stderr)
	case "stop":
		return runDshStop(args[1:], stdout, stderr)
	default:
		return fail(stderr, errors.New("p2p.invalid_arguments"))
	}
}

// stringList collects one repeatable flag.
type stringList []string

func (values *stringList) String() string { return strings.Join(*values, " ") }

func (values *stringList) Set(value string) error {
	*values = append(*values, value)
	return nil
}

func runDshStart(args []string, stdout io.Writer, stderr io.Writer) int {
	flags := flag.NewFlagSet("dsh start", flag.ContinueOnError)
	flags.SetOutput(stderr)
	state := flags.String("state", "", "per-user state directory")
	directory := flags.String("directory", "", "the Harness checkout to run")
	pnpm := flags.String("pnpm", "", "the pnpm executable or shim to run")
	patch := flags.String("patch", "", "a Cordis overlay applied to this child only")
	port := flags.Int("port", 0, "a fixed port; zero selects automatically")
	var prefix stringList
	flags.Var(&prefix, "pnpm-prefix", "one pnpm shim prefix argument (repeatable)")
	if flags.Parse(args) != nil {
		return 2
	}
	if *directory == "" || *pnpm == "" {
		return fail(stderr, errors.New("p2p.invalid_arguments"))
	}
	setting := harnessruntime.AutoPort()
	if *port != 0 {
		fixed, err := harnessruntime.FixedPort(*port)
		if err != nil {
			return fail(stderr, err)
		}
		setting = fixed
	}
	stateDirectory, err := stateRoot(*state)
	if err != nil {
		return fail(stderr, err)
	}
	request := struct {
		LaunchID              string                     `json:"launchId"`
		SubjectID             string                     `json:"subjectId"`
		Directory             string                     `json:"directory"`
		PnpmExecutable        string                     `json:"pnpmExecutable"`
		PnpmPrefixArguments   []string                   `json:"pnpmPrefixArguments"`
		PnpmResolutionError   string                     `json:"pnpmResolutionError"`
		PnpmCommandSearchPath string                     `json:"pnpmCommandSearchPath"`
		DiagnosticsPatchPath  string                     `json:"diagnosticsPatchPath"`
		Port                  harnessruntime.PortSetting `json:"port"`
		LogPath               string                     `json:"logPath"`
	}{
		LaunchID:             newIdentifier(),
		SubjectID:            HeadlessSubject,
		Directory:            *directory,
		PnpmExecutable:       *pnpm,
		PnpmPrefixArguments:  []string(prefix),
		DiagnosticsPatchPath: *patch,
		Port:                 setting,
		LogPath:              filepath.Join(stateDirectory, "dsh-web.log"),
	}
	if len(request.PnpmPrefixArguments) == 0 {
		request.PnpmPrefixArguments = []string{}
	}
	if request.DiagnosticsPatchPath == "" {
		// A launch without an overlay is legitimate, and the core requires an
		// absolute path, so the state directory names the file it would read.
		request.DiagnosticsPatchPath = filepath.Join(stateDirectory, "no-overlay.yml")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	client, closeClient, err := clientFor(ctx, stateDirectory)
	if err != nil {
		return fail(stderr, err)
	}
	defer closeClient()
	answer, err := client.Call(ctx, "runtime.start", request)
	if err != nil {
		return fail(stderr, err)
	}
	if _, err := fmt.Fprintf(stdout, "%s\n", answer); err != nil {
		return fail(stderr, err)
	}
	return 0
}

func runDshStop(args []string, stdout io.Writer, stderr io.Writer) int {
	flags := flag.NewFlagSet("dsh stop", flag.ContinueOnError)
	flags.SetOutput(stderr)
	state := flags.String("state", "", "per-user state directory")
	if flags.Parse(args) != nil {
		return 2
	}
	stateDirectory, err := stateRoot(*state)
	if err != nil {
		return fail(stderr, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	client, closeClient, err := clientFor(ctx, stateDirectory)
	if err != nil {
		return fail(stderr, err)
	}
	defer closeClient()
	answer, err := client.Call(ctx, "runtime.stop", struct {
		SubjectID string `json:"subjectId"`
	}{HeadlessSubject})
	if err != nil {
		return fail(stderr, err)
	}
	if _, err := fmt.Fprintf(stdout, "%s\n", answer); err != nil {
		return fail(stderr, err)
	}
	return 0
}

// runCall sends one method with a complete payload. It is what makes the CLI
// whole: every published operation is reachable even before it has a friendlier
// command, and the refusal code is printed verbatim.
func runCall(args []string, stdout io.Writer, stderr io.Writer) int {
	// The method and its payload are positional and the state flag may follow
	// them, which the standard flag package would otherwise read as the payload.
	remaining, stateValue := splitStateFlag(args)
	if len(remaining) == 0 {
		return fail(stderr, errors.New("p2p.invalid_arguments"))
	}
	method := remaining[0]
	payload := json.RawMessage("{}")
	if len(remaining) > 1 {
		candidate := remaining[1]
		if candidate == "-" {
			data, err := io.ReadAll(io.LimitReader(os.Stdin, 1<<20))
			if err != nil {
				return fail(stderr, err)
			}
			candidate = strings.TrimSpace(string(data))
		}
		if !json.Valid([]byte(candidate)) {
			return fail(stderr, errors.New("p2p.invalid_json"))
		}
		payload = json.RawMessage(candidate)
	}
	stateDirectory, err := stateRoot(stateValue)
	if err != nil {
		return fail(stderr, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	client, closeClient, err := clientFor(ctx, stateDirectory)
	if err != nil {
		return fail(stderr, err)
	}
	defer closeClient()
	answer, err := client.Call(ctx, method, payload)
	if err != nil {
		return fail(stderr, err)
	}
	if _, err := fmt.Fprintf(stdout, "%s\n", answer); err != nil {
		return fail(stderr, err)
	}
	return 0
}

// splitStateFlag removes one --state flag from anywhere in a positional command.
func splitStateFlag(args []string) ([]string, string) {
	remaining := make([]string, 0, len(args))
	state := ""
	for index := 0; index < len(args); index++ {
		argument := args[index]
		if argument == "--state" && index+1 < len(args) {
			state = args[index+1]
			index++
			continue
		}
		if strings.HasPrefix(argument, "--state=") {
			state = strings.TrimPrefix(argument, "--state=")
			continue
		}
		remaining = append(remaining, argument)
	}
	return remaining, state
}

// newIdentifier returns one opaque launch id.
func newIdentifier() string {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "launch"
	}
	return "launch-" + hex.EncodeToString(value)
}

// fail prints one refusal code and returns the process exit code for it.
func fail(stderr io.Writer, err error) int {
	fmt.Fprintln(stderr, err.Error())
	return 1
}

// printJSON prints several raw answers as one object.
func printJSON(stdout io.Writer, stderr io.Writer, values map[string]json.RawMessage) int {
	encoded, err := json.Marshal(values)
	if err != nil {
		return fail(stderr, err)
	}
	if _, err := fmt.Fprintf(stdout, "%s\n", encoded); err != nil {
		return fail(stderr, err)
	}
	return 0
}
