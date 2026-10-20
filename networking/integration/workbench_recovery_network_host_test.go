//go:build live

package integration

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/peersession"
	"github.com/ankye/dshker/networking/internal/protocol"
)

// This is a test composition of the production policy, not a macOS serve core.
// No operation exposed here asks the manager to connect or reconcile.
type recoveryNetworkAutoOwner interface {
	Observe(peersession.State)
	Wake(string)
	BindManager(*testing.T, *peersession.Manager)
	Start(*testing.T, peersession.State)
	Current() (peersession.State, bool)
	Attempts() uint64
	Close()
}

func recoveryNetworkControl(ctx context.Context, config recoveryCrossConfig, operation string) (recoveryCrossStatus, error) {
	if operation != "/reverse-network-state" {
		return recoveryCrossStatus{}, errors.New("test.network_observation_operation_invalid")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, config.ControlURL+operation, nil)
	if err != nil {
		return recoveryCrossStatus{}, errors.New("test.network_observation_request_invalid")
	}
	request.Header.Set("Authorization", "Bearer "+config.ControlSecret)
	client := &http.Client{Timeout: 15 * time.Second, Transport: &http.Transport{Proxy: nil, DisableKeepAlives: true}}
	response, err := client.Do(request)
	if err != nil {
		return recoveryCrossStatus{}, errors.New("test.network_observation_unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return recoveryCrossStatus{}, errors.New("test.network_observation_refused")
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, protocol.MaxControlBytes+1))
	if err != nil || len(data) > protocol.MaxControlBytes {
		return recoveryCrossStatus{}, errors.New("test.network_observation_size_invalid")
	}
	var answer recoveryCrossStatus
	var envelope struct {
		Network json.RawMessage `json:"network"`
	}
	if json.Unmarshal(data, &answer) != nil || json.Unmarshal(data, &envelope) != nil || answer.Network == nil || protocol.DecodeExact(envelope.Network, answer.Network) != nil {
		return recoveryCrossStatus{}, errors.New("test.network_observation_shape_invalid")
	}
	return answer, nil
}

type recoveryNetworkProof struct {
	Case             string `json:"case"`
	Armed            bool   `json:"armed"`
	ReadbackComplete bool   `json:"readbackComplete"`
	OriginalWS       bool   `json:"originalWS"`
	SameCookie       bool   `json:"sameCookie"`
	EngineAttempts   uint64 `json:"engineAttempts"`
	InitialAttempt   string `json:"initialAttempt"`
	InitialWS        string `json:"initialWs"`
}

type recoverySealedProof struct {
	State           peersession.State `json:"state"`
	WSID            string            `json:"wsId"`
	WorkspaceID     string            `json:"workspaceId"`
	SessionID       string            `json:"sessionId"`
	ClosedAndJoined bool              `json:"closedAndJoined"`
}

func recoveryRequireSealed(t *testing.T, answer recoveryCrossStatus, reverse *recoveryReverseStatus) {
	t.Helper()
	proof := answer.Sealed
	if proof == nil || !proof.ClosedAndJoined || proof.State != reverse.State || proof.WSID != reverse.WSID || proof.WorkspaceID != reverse.WorkspaceID || proof.SessionID != reverse.SessionID {
		t.Fatal("finish requires exact current attempt/workspace/session/WS close-and-join acknowledgement")
	}
}

type recoveryNetworkHost struct {
	reverse  *recoveryReverseBrowser
	auto     recoveryNetworkAutoOwner
	plan     recoveryNetworkPlan
	baseline recoveryReverseStatus
	stream   *recoveryWS
	cookie   [32]byte
	armed    bool
	readback bool
	same     bool
}

func recoveryNewNetworkHost(t *testing.T, reverse *recoveryReverseBrowser, auto recoveryNetworkAutoOwner, name string) *recoveryNetworkHost {
	t.Helper()
	plan, err := recoveryNetworkCasePlan(name)
	must(t, err)
	return recoveryNewFaultHost(t, reverse, auto, plan)
}

func recoveryNewFaultHost(t *testing.T, reverse *recoveryReverseBrowser, auto recoveryNetworkAutoOwner, plan recoveryNetworkPlan) *recoveryNetworkHost {
	t.Helper()
	return &recoveryNetworkHost{reverse: reverse, auto: auto, plan: plan, baseline: *reverse.status(), stream: reverse.stream, cookie: reverse.browser.cookieDigest(t)}
}

func recoveryNewCrashHost(t *testing.T, reverse *recoveryReverseBrowser, auto recoveryNetworkAutoOwner) *recoveryNetworkHost {
	return &recoveryNetworkHost{reverse: reverse, auto: auto, plan: recoveryNetworkPlan{Name: "core-crash", Long: true}, baseline: *reverse.status(), stream: reverse.stream, cookie: reverse.browser.cookieDigest(t)}
}

func (host *recoveryNetworkHost) proof() *recoveryNetworkProof {
	original := host.reverse.stream == host.stream
	if original {
		select {
		case <-host.stream.done:
			original = false
		default:
		}
	}
	return &recoveryNetworkProof{
		Case: host.plan.Name, Armed: host.armed, ReadbackComplete: host.readback,
		OriginalWS: original, SameCookie: host.same, EngineAttempts: host.auto.Attempts(),
		InitialAttempt: host.baseline.State.AttemptID, InitialWS: host.baseline.WSID,
	}
}

func (host *recoveryNetworkHost) observe(t *testing.T) peersession.State {
	t.Helper()
	current, available := host.auto.Current()
	if !available || current.PairID != host.baseline.State.PairID || current.Generation < host.baseline.State.Generation {
		t.Fatal("automatic Mac owner lost its scoped outbound identity")
	}
	// This snapshot may be superseded immediately by the production worker.
	// State observation never promotes it to authoritative application readiness;
	// exact Entry/gateway/runtime checks belong to the actual readback boundary.
	host.reverse.current = current
	return current
}

func (host *recoveryNetworkHost) control(t *testing.T, ctx context.Context, operation string) {
	t.Helper()
	current := host.observe(t)
	switch operation {
	case "/reverse-network-arm":
		if host.armed || current != host.baseline.State || host.auto.Attempts() != 0 {
			t.Fatal("network fault must arm once on its original ready outbound session")
		}
		host.stream.healthy(t)
		host.armed = true
		host.same = host.reverse.browser.cookieDigest(t) == host.cookie
		if host.plan.Long {
			host.stream.mu.Lock()
			host.stream.expectLoss = true
			host.stream.mu.Unlock()
		}
	case "/reverse-network-state":
		if !host.armed {
			t.Fatal("network observation preceded the admitted fault")
		}
	case "/reverse-network-readback":
		if !host.armed || host.readback || current.Stage != "ready" {
			t.Fatal("network readback requires one naturally recovered ready session")
		}
		entry, err := host.reverse.manager.Entry(current.PairID, current.Generation)
		must(t, err)
		if entry.State != current || entry.URL != host.reverse.url || current.RuntimeGeneration != host.baseline.State.RuntimeGeneration {
			t.Fatal("automatic Mac recovery moved its original gateway or runtime")
		}
		if host.reverse.browser.cookieDigest(t) != host.cookie {
			t.Fatal("automatic network recovery replaced the original Mac cookie")
		}
		if host.plan.Long {
			if current.AttemptID == host.baseline.State.AttemptID || current.Generation <= host.baseline.State.Generation || host.auto.Attempts() == 0 {
				t.Fatal("long network loss did not exercise automatic Mac attempt replacement")
			}
			assertRecoveryStreamClosed(t, ctx, host.stream)
			host.reverse.openStream(t, ctx)
			if host.reverse.wsID == host.baseline.WSID {
				t.Fatal("replacement carrier falsely reused the naturally closed WS identity")
			}
		} else {
			if current != host.baseline.State || host.auto.Attempts() != 0 || host.reverse.stream != host.stream {
				t.Fatal("short network interruption replaced the original Mac attempt or WS")
			}
			host.reverse.readback(t, ctx)
		}
		host.same = host.reverse.browser.cookieDigest(t) == host.cookie
		if !host.same {
			t.Fatal("network readback refreshed the original Mac cookie")
		}
		host.readback = true
		marker := "network-fault-readback"
		if host.plan.Direction == "program" {
			marker = "program-pause-host-readback"
		}
		t.Logf("%s direction=mac-to-windows case=%s trigger=production-engine periodicSweep=5s pair=%s attempt=%s generation=%d runtimeGeneration=%d workspace=%s session=%s ws=%s originalWS=%t sameGateway=true sameCookie=true engineAttempts=%d", marker, host.plan.Name, current.PairID, current.AttemptID, current.Generation, current.RuntimeGeneration, host.reverse.workspace.ID, host.reverse.session, host.reverse.wsID, !host.plan.Long, host.auto.Attempts())
	default:
		t.Fatal("unknown network host control")
	}
}
