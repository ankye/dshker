package peer

import (
	"bytes"
	"encoding/json"
	"errors"
	"math"
	"net/netip"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

func TestTransportDiagnosticsUnknownStatsDoNotInventReceives(t *testing.T) {
	for _, timestamp := range []float64{0, -1, math.NaN(), math.Inf(1), math.Inf(-1)} {
		sample := receiveDiagnosticsFromStats(webrtc.ICECandidatePairStats{Timestamp: webrtc.StatsTimestamp(timestamp)})
		if sample.Available || sample.SampledAt != nil || sample.PacketsReceived != nil || sample.RequestsReceived != nil || sample.LastPacketReceivedAt != nil {
			t.Fatal("unavailable dependency statistics were represented as observed receives")
		}
	}
	knownZero := receiveDiagnosticsFromStats(webrtc.ICECandidatePairStats{Timestamp: webrtc.StatsTimestamp(time.Now().UnixMilli())})
	if !knownZero.Available || knownZero.PacketsReceived == nil || *knownZero.PacketsReceived != 0 || knownZero.RequestsReceived == nil || *knownZero.RequestsReceived != 0 {
		t.Fatal("a complete candidate-pair report lost its genuinely observed zero counters")
	}
	if knownZero.LastPacketReceivedAt != nil || knownZero.LastRequestReceivedAt != nil || knownZero.LastResponseReceivedAt != nil {
		t.Fatal("an uninitialised receive timestamp was represented as an actual receive")
	}
}

func TestTransportDiagnosticsReadsRealSelectedPairReceiveStats(t *testing.T) {
	ctx, left, right := streamPair(t)
	sender, err := left.Open()
	if err != nil {
		t.Fatal(err)
	}
	receiver, err := right.Accept(ctx)
	if err != nil {
		t.Fatal(err)
	}
	payload := []byte("diagnostic receive statistics")
	if _, err := sender.Write(ctx, payload); err != nil {
		t.Fatal(err)
	}
	buffer := make([]byte, len(payload))
	if n, err := receiver.Read(ctx, buffer); err != nil || n != len(payload) || !bytes.Equal(buffer, payload) {
		t.Fatal("the real transport did not deliver the diagnostic test message", n, err)
	}
	var requests, responses uint64
	for _, mux := range []*Mux{left, right} {
		transport := mux.link.(*Transport)
		batch := transport.sampleTransportDiagnostics()
		sample := batch.Receive
		if !sample.Available || sample.SampledAt == nil || sample.PacketsReceived == nil || *sample.PacketsReceived == 0 || sample.BytesReceived == nil || *sample.BytesReceived == 0 || sample.LastPacketReceivedAt == nil {
			t.Fatal("the current selected pair did not expose its real non-STUN receive counters and timestamp")
		}
		if sample.RequestsReceived == nil || sample.ResponsesReceived == nil {
			t.Fatal("the full selected-pair report omitted implemented STUN receive counters")
		}
		if *sample.RequestsReceived > 0 && sample.LastRequestReceivedAt == nil {
			t.Fatal("an actual STUN request count lost its implemented receive timestamp")
		}
		if *sample.ResponsesReceived > 0 && sample.LastResponseReceivedAt == nil {
			t.Fatal("an actual STUN response count lost its implemented receive timestamp")
		}
		requests += *sample.RequestsReceived
		responses += *sample.ResponsesReceived
		if transport.Diagnostics().Receive.LastDataChannelMessageAt == nil {
			t.Fatal("an actual DataChannel callback receipt was not recorded independently of periodic stats")
		}
		path := batch.SelectedPath
		actual, err := transport.pc.SCTP().Transport().ICETransport().GetSelectedCandidatePair()
		if err != nil || actual == nil || path == nil || netip.MustParseAddr(path.LocalAddress).WithZone("") != netip.MustParseAddr(actual.Local.Address).WithZone("") || path.LocalPort != int32(actual.Local.Port) || netip.MustParseAddr(path.RemoteAddress).WithZone("") != netip.MustParseAddr(actual.Remote.Address).WithZone("") || path.RemotePort != int32(actual.Remote.Port) || path.LocalType != actual.Local.Typ.String() || path.RemoteType != actual.Remote.Typ.String() || path.Protocol != actual.Local.Protocol.String() {
			t.Fatal("diagnostic network tuple did not identify the real selected candidate pair")
		}
	}
	if requests == 0 || responses == 0 {
		t.Fatal("real ICE checks were hidden by the selected-only getter's unimplemented zero fields")
	}
	transport := right.link.(*Transport)
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	poll := time.NewTicker(10 * time.Millisecond)
	defer poll.Stop()
	for !transport.Diagnostics().Receive.Available || transport.Diagnostics().SelectedPath == nil {
		select {
		case <-deadline.C:
			t.Fatal("the single periodic diagnostic worker did not publish available receive statistics")
		case <-poll.C:
		}
	}
	selected := transport.Diagnostics().SelectedPath
	if err := transport.Close(); err != nil {
		t.Fatal(err)
	}
	failure := transport.Diagnostics().Failure
	if failure == nil || failure.PCState != "connected" || failure.ICEState != "connected" || failure.DataChannelState != "open" {
		t.Fatal("the first termination record lost the actual pre-cleanup transport states")
	}
	if !reflect.DeepEqual(failure.SelectedPath, selected) {
		t.Fatal("the first termination record did not freeze the last selected network tuple")
	}
}

func TestTransportDiagnosticsSelectedPathScopeAndClearing(t *testing.T) {
	pair := webrtc.ICECandidatePairStats{ID: "selected-pair", LocalCandidateID: "local", RemoteCandidateID: "remote", Timestamp: webrtc.StatsTimestamp(time.Now().UnixMilli())}
	local := webrtc.ICECandidateStats{ID: "local", IP: "127.0.0.1", Port: 10001, Protocol: "udp", CandidateType: webrtc.ICECandidateTypeHost, URL: "stun:fixture-credential@gateway.invalid"}
	remote := local
	remote.ID, remote.Port = "remote", 10002
	report := webrtc.StatsReport{pair.ID: pair, local.ID: local, remote.ID: remote}
	transport := newGraceTestTransport()
	defer transport.cancel()
	transport.publishDiagnosticSample(diagnosticSampleFromReport(report, pair, pair))
	if transport.Diagnostics().SelectedPath == nil {
		t.Fatal("a complete exact selected report lost its network tuple")
	}
	changed := pair
	changed.ID = "another-pair"
	transport.publishDiagnosticSample(diagnosticSampleFromReport(report, pair, changed))
	if snapshot := transport.Diagnostics(); snapshot.SelectedPath != nil || snapshot.Receive.Available {
		t.Fatal("a selected pair change retained the previous network tuple or receive scope")
	}
	for _, corrupt := range []func(){
		func() { remote.ID = "stale-candidate" },
		func() { remote.IP = "fixture-user:fixture-secret@gateway.invalid" },
		func() { remote.Port = 0 },
		func() { remote.Protocol = "fixture-secret" },
		func() { remote.CandidateType = webrtc.ICECandidateTypeUnknown },
	} {
		remote = local
		remote.ID, remote.Port = "remote", 10002
		corrupt()
		report["remote"] = remote
		if diagnosticSampleFromReport(report, pair, pair).SelectedPath != nil {
			t.Fatal("incomplete or untrusted candidate metadata escaped as a selected network tuple")
		}
	}
	remote = local
	remote.ID, remote.Port = "remote", 10002
	report["remote"] = remote
	safe := diagnosticSampleFromReport(report, pair, pair).SelectedPath
	if safe == nil {
		t.Fatal("safe selected metadata was dropped merely because its unexported candidate carried a server URL")
	}
	encoded, err := json.Marshal(safe)
	if err != nil || strings.Contains(string(encoded), "fixture-credential") || strings.Contains(string(encoded), "gateway.invalid") {
		t.Fatal("selected network diagnostics exposed a STUN/TURN URL or credentials")
	}
	local.IP, remote.IP = "fe80::1%test0", "fe80::2%test1"
	report["local"], report["remote"] = local, remote
	scoped := diagnosticSampleFromReport(report, pair, pair).SelectedPath
	if scoped == nil || scoped.LocalAddress != local.IP || scoped.RemoteAddress != remote.IP {
		t.Fatal("a valid scoped IPv6 selected tuple was dropped or lost its interface zone")
	}
}

func TestTransportDiagnosticsSelectedPathFrozenWithReceiveSample(t *testing.T) {
	transport := newGraceTestTransport()
	defer transport.cancel()
	first := transportDiagnosticSample{
		Receive:      TransportReceiveDiagnostics{Available: true, SampledAt: diagnosticPointer(time.Now().UTC()), PacketsReceived: diagnosticPointer(uint64(7))},
		SelectedPath: &TransportPathDiagnostics{LocalAddress: "127.0.0.1", LocalPort: 10001, RemoteAddress: "127.0.0.1", RemotePort: 10002, Protocol: "udp"},
	}
	transport.publishDiagnosticSample(first)
	transport.recordTermination("lease-expired", errors.New("p2p.lease_expired"))
	transport.publishDiagnosticSample(transportDiagnosticSample{
		Receive:      TransportReceiveDiagnostics{Available: true, PacketsReceived: diagnosticPointer(uint64(99))},
		SelectedPath: &TransportPathDiagnostics{LocalAddress: "::1", LocalPort: 20001, RemoteAddress: "::1", RemotePort: 20002, Protocol: "udp"},
	})
	snapshot := transport.Diagnostics()
	if snapshot.SelectedPath.LocalPort != 20001 || snapshot.Failure == nil || !reflect.DeepEqual(snapshot.Failure.SelectedPath, first.SelectedPath) || !reflect.DeepEqual(snapshot.Failure.Receive, first.Receive) {
		t.Fatal("later selected-path sampling changed the first failure's atomically paired tuple and receive facts")
	}
}
