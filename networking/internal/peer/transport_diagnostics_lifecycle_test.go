package peer

import (
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/logging"
	"github.com/pion/webrtc/v4"
)

type diagnosticICEStatsTestSource struct {
	state    atomic.Int32
	selected func() (webrtc.ICECandidatePairStats, bool)
}

func (source *diagnosticICEStatsTestSource) State() webrtc.ICETransportState {
	return webrtc.ICETransportState(source.state.Load())
}

func (source *diagnosticICEStatsTestSource) GetSelectedCandidatePairStats() (webrtc.ICECandidatePairStats, bool) {
	return source.selected()
}

func diagnosticLifecycleReport() (webrtc.ICECandidatePairStats, webrtc.StatsReport) {
	pair := webrtc.ICECandidatePairStats{ID: "selected", LocalCandidateID: "local", RemoteCandidateID: "remote", Timestamp: webrtc.StatsTimestamp(time.Now().UnixMilli()), PacketsReceived: 3, BytesReceived: 99, RequestsReceived: 2, ResponsesReceived: 1}
	local := webrtc.ICECandidateStats{ID: "local", IP: "127.0.0.1", Port: 10001, Protocol: "udp", CandidateType: webrtc.ICECandidateTypeHost}
	remote := local
	remote.ID, remote.Port = "remote", 10002
	return pair, webrtc.StatsReport{pair.ID: pair, local.ID: local, remote.ID: remote}
}

func TestTransportDiagnosticsUnstartedPionStatsRemainUnknown(t *testing.T) {
	// This real public Pion transport deliberately has no gatherer. Calling its
	// selected getter before startup would dereference nil, not merely race.
	ice := webrtc.NewICETransport(nil, logging.NewDefaultLoggerFactory())
	fullStats := func() webrtc.StatsReport {
		t.Fatal("unstarted Pion transport collected a report before publishing its gatherer")
		return nil
	}
	for _, phase := range []string{"before-start", "after-close"} {
		if phase == "after-close" {
			if err := ice.Stop(); err != nil {
				t.Fatal(err)
			}
		}
		sample := sampleSelectedTransportDiagnostics(ice, fullStats)
		if sample.Receive.Available || sample.Receive.PacketsReceived != nil || sample.SelectedPath != nil {
			t.Fatal("unstarted or closed real Pion transport invented selected statistics")
		}
	}
}

func TestTransportDiagnosticsWaitsForICEStartPublication(t *testing.T) {
	pair, report := diagnosticLifecycleReport()
	selectedReads, fullReads := 0, 0
	source := &diagnosticICEStatsTestSource{selected: func() (webrtc.ICECandidatePairStats, bool) {
		selectedReads++
		return pair, true
	}}
	fullStats := func() webrtc.StatsReport { fullReads++; return report }
	for _, state := range []webrtc.ICETransportState{webrtc.ICETransportStateUnknown, webrtc.ICETransportStateNew, webrtc.ICETransportStateClosed} {
		source.state.Store(int32(state))
		sample := sampleSelectedTransportDiagnostics(source, fullStats)
		if selectedReads != 0 || fullReads != 0 || sample.Receive.Available || sample.Receive.PacketsReceived != nil || sample.SelectedPath != nil {
			t.Fatal("unpublished or closed ICE read the unsafe selected getter or invented current statistics")
		}
	}
	for _, state := range []webrtc.ICETransportState{webrtc.ICETransportStateChecking, webrtc.ICETransportStateConnected, webrtc.ICETransportStateCompleted, webrtc.ICETransportStateDisconnected, webrtc.ICETransportStateFailed} {
		source.state.Store(int32(state))
		sample := sampleSelectedTransportDiagnostics(source, fullStats)
		if !sample.Receive.Available || sample.Receive.PacketsReceived == nil || *sample.Receive.PacketsReceived != 3 || sample.Receive.RequestsReceived == nil || *sample.Receive.RequestsReceived != 2 || sample.SelectedPath == nil || sample.SelectedPath.LocalPort != 10001 {
			t.Fatal("published ICE state lost the exact selected pair, receive counters or network tuple")
		}
	}
	if selectedReads != 10 || fullReads != 5 {
		t.Fatal("safe ICE sampling did not preserve both selected-ID checks around every full report")
	}
}

func TestTransportDiagnosticsCloseDuringStatsCollection(t *testing.T) {
	pair, report := diagnosticLifecycleReport()
	selectedReads := 0
	source := &diagnosticICEStatsTestSource{selected: func() (webrtc.ICECandidatePairStats, bool) {
		selectedReads++
		return pair, true
	}}
	source.state.Store(int32(webrtc.ICETransportStateConnected))
	collecting, release := make(chan struct{}), make(chan struct{})
	result := make(chan transportDiagnosticSample, 1)
	go func() {
		result <- sampleSelectedTransportDiagnostics(source, func() webrtc.StatsReport {
			close(collecting)
			<-release
			return report
		})
	}()
	<-collecting
	source.state.Store(int32(webrtc.ICETransportStateClosed))
	close(release)
	sample := <-result
	if selectedReads != 1 || sample.Receive.Available || sample.Receive.PacketsReceived != nil || sample.SelectedPath != nil {
		t.Fatal("close during collection read the closed selected getter or published a stale selected scope")
	}
}

func TestTransportDiagnosticsSelectedReplacementDuringStatsCollection(t *testing.T) {
	pair, report := diagnosticLifecycleReport()
	selectedReads := 0
	current := pair
	source := &diagnosticICEStatsTestSource{selected: func() (webrtc.ICECandidatePairStats, bool) {
		selectedReads++
		return current, true
	}}
	source.state.Store(int32(webrtc.ICETransportStateConnected))
	collecting, release := make(chan struct{}), make(chan struct{})
	result := make(chan transportDiagnosticSample, 1)
	go func() {
		result <- sampleSelectedTransportDiagnostics(source, func() webrtc.StatsReport {
			close(collecting)
			<-release
			return report
		})
	}()
	<-collecting
	current.ID, current.RemoteCandidateID = "replacement", "replacement-remote"
	close(release)
	sample := <-result
	if selectedReads != 2 || sample.Receive.Available || sample.SelectedPath != nil {
		t.Fatal("selected-pair replacement combined old report counters or tuple with the current attempt")
	}
}
