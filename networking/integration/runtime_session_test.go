package integration

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/controlplane"
	"github.com/ankye/dshker/networking/internal/peersession"
	"github.com/ankye/dshker/networking/internal/runtimebridge"
)

// This diagnostic runs the production coordinator, production Go managers and
// an explicitly selected real DSH process. It does not prove Electron UI wiring.
func TestManagerRealDSH(t *testing.T) {
	runtimeURL, runtimeProcess := startRealDSH(t)
	var bindingMu sync.Mutex
	binding := runtimebridge.Binding{Generation: 1, URL: runtimeURL}
	f := newFixture(t)
	ctx, cancel := context.WithTimeout(f.ctx, 80*time.Second)
	defer cancel()
	var managers [2]*peersession.Manager
	var states [2]chan peersession.State
	for _, i := range []int{1, 0} {
		config := f.config[i]
		states[i] = make(chan peersession.State, 128)
		owner := func(context.Context, string) (runtimebridge.Binding, error) {
			if i != 1 {
				return runtimebridge.Binding{}, errors.New("p2p.unexpected_runtime_owner")
			}
			bindingMu.Lock()
			defer bindingMu.Unlock()
			return binding, nil
		}
		manager, err := peersession.New(ctx, f.devices[i], peersession.Config{Endpoints: config.Endpoints, Authority: config.Authority, Device: config.Device, PrivateKey: config.Private}, []controlplane.PairIdentity{config.Pin}, owner, func(state peersession.State) { states[i] <- state })
		must(t, err)
		managers[i] = manager
		defer manager.Close()
	}
	pairID := f.config[0].Pin.Pair.PairID
	previousAttempt := ""
	for generation := uint64(1); generation <= 5; generation++ {
		// This is the normal reconnect scenario, paced below the coordinator's
		// documented 20 requests/source/second limit, not a retry on rejection.
		select {
		case <-time.After(time.Second):
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
		connected, err := managers[0].Connect(ctx, pairID, generation)
		if err != nil {
			t.Fatalf("generation %d connect: %v", generation, err)
		}
		if connected.State.Stage != "ready" || connected.State.PairID != pairID || connected.State.Generation != generation || connected.State.RuntimeGeneration != 1 || connected.State.AttemptID == "" || connected.State.AttemptID == previousAttempt {
			t.Fatalf("incorrect connected identity/state: %+v", connected.State)
		}
		path := connected.State.Path
		if path.Protocol != "udp" || path.LocalType == "" || path.RemoteType == "" || path.LocalType == "relay" || path.RemoteType == "relay" {
			t.Fatalf("connection did not select direct UDP: %+v", path)
		}
		previousAttempt = connected.State.AttemptID
		must(t, runtimebridge.Probe(ctx, connected.URL))
		must(t, managers[0].Disconnect(pairID))
		request, err := http.NewRequestWithContext(ctx, "GET", connected.URL, nil)
		must(t, err)
		probe := &http.Client{Timeout: time.Second}
		response, err := probe.Do(request)
		if response != nil {
			response.Body.Close()
		}
		if err == nil {
			t.Fatal("old browser gateway remains reachable after Disconnect")
		}
		waitDisconnected(t, ctx, states[1], previousAttempt)
		must(t, runtimebridge.Probe(ctx, runtimeURL))
	}
	// An actual DSH process restart changes the announced endpoint and token.
	time.Sleep(time.Second)
	connected, err := managers[0].Connect(ctx, pairID, 6)
	must(t, err)
	runtimeProcess.stop(t, false)
	managers[1].InvalidateRuntime(1)
	waitDisconnected(t, ctx, states[0], connected.State.AttemptID)
	waitDisconnected(t, ctx, states[1], connected.State.AttemptID)
	assertGatewayClosed(t, ctx, connected.URL)
	nextURL, _ := startRealDSH(t)
	if nextURL == runtimeURL {
		t.Fatal("restarted DSH reused old runtime credential")
	}
	bindingMu.Lock()
	binding = runtimebridge.Binding{Generation: 2, URL: nextURL}
	bindingMu.Unlock()
	time.Sleep(time.Second)
	connected, err = managers[0].Connect(ctx, pairID, 7)
	must(t, err)
	if connected.State.RuntimeGeneration != 2 || connected.State.AttemptID == previousAttempt {
		t.Fatal("reconnect selected stale runtime identity")
	}
	must(t, runtimebridge.Probe(ctx, connected.URL))
	managers[0].Close()
	assertGatewayClosed(t, ctx, connected.URL)
	must(t, runtimebridge.Probe(ctx, nextURL))
}

func assertGatewayClosed(t *testing.T, ctx context.Context, value string) {
	t.Helper()
	request, err := http.NewRequestWithContext(ctx, "GET", value, nil)
	must(t, err)
	client := &http.Client{Timeout: time.Second}
	response, err := client.Do(request)
	if response != nil {
		response.Body.Close()
	}
	if err == nil {
		t.Fatal("stale gateway remains reachable")
	}
}

func waitDisconnected(t *testing.T, ctx context.Context, states <-chan peersession.State, attempt string) {
	t.Helper()
	deadline, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	for {
		select {
		case state := <-states:
			if state.AttemptID == attempt && state.Stage == "disconnected" {
				return
			}
		case <-deadline.Done():
			t.Fatal("target did not observe disconnect")
		}
	}
}

func startRealDSH(t *testing.T) (string, *process) {
	t.Helper()
	root := os.Getenv("DSHKER_TEST_HARNESS_ROOT")
	if !filepath.IsAbs(root) {
		t.Fatal("explicit DSHKER_TEST_HARNESS_ROOT required")
	}
	entry := filepath.Join(root, "apps", "cli", "lib", "bin.js")
	info, err := os.Stat(entry)
	must(t, err)
	if !info.Mode().IsRegular() {
		t.Fatal("DSH CLI entry is not a regular file")
	}
	node, err := exec.LookPath("node")
	must(t, err)
	temporary := t.TempDir()
	project := filepath.Join(temporary, "project")
	must(t, os.Mkdir(project, 0700))
	cmd := exec.Command(node, entry, "--profile", "web", "--no-open", "--port", "0")
	cmd.Dir = project
	for _, value := range os.Environ() {
		if !strings.HasPrefix(value, "DSH_HOME=") {
			cmd.Env = append(cmd.Env, value)
		}
	}
	cmd.Env = append(cmd.Env, "DSH_HOME="+filepath.Join(temporary, "home"))
	stdout, err := cmd.StdoutPipe()
	must(t, err)
	stderr, err := cmd.StderrPipe()
	must(t, err)
	announced := make(chan string, 1)
	pattern := regexp.MustCompile(`dsh web:\s+(http://127\.0\.0\.1:\d+/\?token=\S+)`)
	read := func(reader io.Reader) {
		scanner := bufio.NewScanner(reader)
		for scanner.Scan() {
			if match := pattern.FindStringSubmatch(scanner.Text()); len(match) == 2 {
				select {
				case announced <- match[1]:
				default:
				}
			}
		}
	}
	process := launch(t, cmd)
	go read(stdout)
	go read(stderr)
	select {
	case value := <-announced:
		return value, process
	case <-process.done:
		t.Fatal("real DSH exited before runtime announcement")
	case <-time.After(70 * time.Second):
		t.Fatal("real DSH startup timeout")
	}
	return "", nil
}
