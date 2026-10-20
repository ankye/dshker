package peer

import (
	"math"
	"net/netip"
	"time"

	"github.com/pion/webrtc/v4"
)

const transportDiagnosticInterval = time.Second

type transportDiagnosticSample struct {
	Receive      TransportReceiveDiagnostics
	SelectedPath *TransportPathDiagnostics
}

type diagnosticICEStatsSource interface {
	State() webrtc.ICETransportState
	GetSelectedCandidatePairStats() (webrtc.ICECandidatePairStats, bool)
}

func (transport *Transport) maintainDiagnostics() {
	ticker := time.NewTicker(transportDiagnosticInterval)
	defer ticker.Stop()
	for {
		select {
		case <-transport.ctx.Done():
			return
		case <-ticker.C:
			transport.publishDiagnosticSample(transport.sampleTransportDiagnostics())
		}
	}
}

func (transport *Transport) publishDiagnosticSample(sample transportDiagnosticSample) {
	transport.diagnostics.mu.Lock()
	defer transport.diagnostics.mu.Unlock()
	if transport.ctx.Err() == nil {
		sample.Receive.LastDataChannelMessageAt = transport.diagnostics.value.Receive.LastDataChannelMessageAt
		transport.diagnostics.value.Receive = sample.Receive
		transport.diagnostics.value.SelectedPath = sample.SelectedPath
	}
}

func (transport *Transport) sampleTransportDiagnostics() transportDiagnosticSample {
	unknown := transportDiagnosticSample{Receive: TransportReceiveDiagnostics{SampledAt: diagnosticPointer(time.Now().UTC())}}
	sctp := transport.pc.SCTP()
	if sctp == nil || sctp.Transport() == nil || sctp.Transport().ICETransport() == nil {
		return unknown
	}
	ice := sctp.Transport().ICETransport()
	return sampleSelectedTransportDiagnostics(ice, transport.pc.GetStats)
}

func sampleSelectedTransportDiagnostics(ice diagnosticICEStatsSource, fullStats func() webrtc.StatsReport) transportDiagnosticSample {
	unknown := transportDiagnosticSample{Receive: TransportReceiveDiagnostics{SampledAt: diagnosticPointer(time.Now().UTC())}}
	// Pinned Pion's selected getter reads gatherer without its transport lock.
	// StartContext assigns gatherer while State is New, then publishes later
	// states atomically. A non-New/non-Closed state therefore fences that single
	// assignment before either selected getter. ICETransport cannot start again.
	if !diagnosticICEStarted(ice.State()) {
		return unknown
	}
	before, available := ice.GetSelectedCandidatePairStats()
	if !available {
		return unknown
	}
	// The selected-only Pion getter does NOT populate STUN receive times or
	// request counts. The complete candidate-pair report does. Join by the exact
	// selected ID, and reject a pair replacement during collection.
	report := fullStats()
	if !diagnosticICEStarted(ice.State()) {
		return unknown
	}
	after, available := ice.GetSelectedCandidatePairStats()
	if !available || !diagnosticICEStarted(ice.State()) {
		return unknown
	}
	return diagnosticSampleFromReport(report, before, after)
}

func diagnosticICEStarted(state webrtc.ICETransportState) bool {
	switch state {
	case webrtc.ICETransportStateChecking, webrtc.ICETransportStateConnected, webrtc.ICETransportStateCompleted,
		webrtc.ICETransportStateDisconnected, webrtc.ICETransportStateFailed:
		return true
	default:
		return false
	}
}

func diagnosticSampleFromReport(report webrtc.StatsReport, before, after webrtc.ICECandidatePairStats) transportDiagnosticSample {
	unknown := transportDiagnosticSample{Receive: TransportReceiveDiagnostics{SampledAt: diagnosticPointer(time.Now().UTC())}}
	if before.ID == "" || before.ID != after.ID || before.LocalCandidateID != after.LocalCandidateID || before.RemoteCandidateID != after.RemoteCandidateID {
		return unknown
	}
	stats, found := report[after.ID].(webrtc.ICECandidatePairStats)
	if !found || stats.ID != after.ID || stats.LocalCandidateID != after.LocalCandidateID || stats.RemoteCandidateID != after.RemoteCandidateID {
		return unknown
	}
	receive := receiveDiagnosticsFromStats(stats)
	if !receive.Available {
		return unknown
	}
	return transportDiagnosticSample{Receive: receive, SelectedPath: selectedPathFromReport(report, stats)}
}

func selectedPathFromReport(report webrtc.StatsReport, pair webrtc.ICECandidatePairStats) *TransportPathDiagnostics {
	local, localOK := report[pair.LocalCandidateID].(webrtc.ICECandidateStats)
	remote, remoteOK := report[pair.RemoteCandidateID].(webrtc.ICECandidateStats)
	if !localOK || !remoteOK || local.ID != pair.LocalCandidateID || remote.ID != pair.RemoteCandidateID || !validDiagnosticCandidate(local) || !validDiagnosticCandidate(remote) || local.Protocol != remote.Protocol {
		return nil
	}
	return &TransportPathDiagnostics{
		LocalAddress: local.IP, LocalPort: local.Port, LocalType: local.CandidateType.String(),
		RemoteAddress: remote.IP, RemotePort: remote.Port, RemoteType: remote.CandidateType.String(), Protocol: local.Protocol,
	}
}

func validDiagnosticCandidate(candidate webrtc.ICECandidateStats) bool {
	if _, err := netip.ParseAddr(candidate.IP); err != nil || candidate.Port <= 0 || candidate.Port > 65535 || (candidate.Protocol != "udp" && candidate.Protocol != "tcp") {
		return false
	}
	switch candidate.CandidateType {
	case webrtc.ICECandidateTypeHost, webrtc.ICECandidateTypeSrflx, webrtc.ICECandidateTypePrflx, webrtc.ICECandidateTypeRelay:
		return true
	default:
		return false
	}
}

func receiveDiagnosticsFromStats(stats webrtc.ICECandidatePairStats) TransportReceiveDiagnostics {
	sampledAt := diagnosticStatsTime(stats.Timestamp)
	if sampledAt == nil {
		return TransportReceiveDiagnostics{}
	}
	return TransportReceiveDiagnostics{
		Available: true, SampledAt: sampledAt,
		LastPacketReceivedAt:   diagnosticStatsTime(stats.LastPacketReceivedTimestamp),
		LastRequestReceivedAt:  diagnosticStatsTime(stats.LastRequestReceivedTimestamp),
		LastResponseReceivedAt: diagnosticStatsTime(stats.LastResponseTimestamp),
		PacketsReceived:        diagnosticPointer(uint64(stats.PacketsReceived)), BytesReceived: diagnosticPointer(stats.BytesReceived),
		RequestsReceived: diagnosticPointer(stats.RequestsReceived), ResponsesReceived: diagnosticPointer(stats.ResponsesReceived),
	}
}

func diagnosticStatsTime(value webrtc.StatsTimestamp) *time.Time {
	// Pion converts an uninitialised time.Time into a non-positive timestamp.
	// Neither that value nor zero is an observed receive time.
	if value <= 0 || math.IsNaN(float64(value)) || math.IsInf(float64(value), 0) {
		return nil
	}
	return diagnosticPointer(value.Time())
}
