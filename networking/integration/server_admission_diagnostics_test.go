package integration

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
)

const admissionDiagnosticBytes = 64 * 1024
const admissionDiagnosticLineBytes = 1024

type serverAdmissionDiagnostic struct {
	Timestamp     string `json:"timestamp"`
	Method        string `json:"method"`
	Route         string `json:"route"`
	PrincipalKind string `json:"principalKind"`
	Reason        string `json:"reason"`
	SourceCount   uint32 `json:"sourceCount"`
	GlobalCount   uint32 `json:"globalCount"`
	SourceKeys    uint32 `json:"sourceKeys"`
}

type serverAdmissionSnapshot struct {
	Records         []serverAdmissionDiagnostic `json:"records"`
	StoredBytes     int                         `json:"storedBytes"`
	DroppedRecords  int                         `json:"droppedRecords"`
	MalformedLines  int                         `json:"malformedLines"`
	OverlongLines   int                         `json:"overlongLines"`
	UnfinishedLines int                         `json:"unfinishedLines"`
	IgnoredLines    int                         `json:"ignoredLines"`
}

// This writer belongs only to one fixture's production server stderr. It never
// retains or republishes general server output, DSH output, body data, identities
// or tokens. Records are server-throttled diagnostic samples, not an exhaustive
// count of denied requests. All loss counters stay visible in the final receipt.
type serverAdmissionDiagnostics struct {
	mu       sync.Mutex
	line     []byte
	overflow bool
	finished bool
	view     serverAdmissionSnapshot
}

var admissionDiagnosticPattern = regexp.MustCompile(`^([0-9]{4}/[0-9]{2}/[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?) \[p2p\] admission denied method=(GET|POST|PATCH|DELETE|PUT|HEAD|OPTIONS|CONNECT|TRACE|OTHER) route=([A-Za-z0-9/:_-]{1,160}) principalKind=(ip|device) reason=(source_limit|global_limit|source_capacity|invalid_remote_addr) sourceCount=([0-9]{1,10}) globalCount=([0-9]{1,10}) sourceKeys=([0-9]{1,10})$`)

// Exact registered routes in the independently built server contract. A new or
// malformed diagnostic is reported as a loss, never accepted as arbitrary text.
func admissionRegisteredRoute(method, route string) bool {
	if route == "unmatched" {
		return true
	}
	switch method + " " + route {
	case "GET /health/https", "POST /v1/identity", "POST /v1/enroll", "POST /v1/network/join", "POST /v1/enrollment-query", "POST /v1/certificate-query", "POST /v1/recover-certificate", "POST /v1/register", "POST /v1/login",
		"GET /v1/user", "POST /v1/logout", "GET /v1/networks", "POST /v1/networks", "PATCH /v1/networks/:networkId", "PATCH /v1/networks/:networkId/limit", "DELETE /v1/networks/:networkId", "POST /v1/networks/:networkId/enrollment-tokens", "GET /v1/devices", "GET /v1/networks/:networkId/devices", "POST /v1/networks/:networkId/devices", "DELETE /v1/networks/:networkId/devices/:deviceId", "GET /v1/networks/:networkId/pairs", "DELETE /v1/networks/:networkId/pairs/:pairId",
		"GET /v1/me", "GET /v1/pairs", "GET /v1/pairs/:pairId/identity", "POST /v1/turn-credentials", "GET /v1/signals", "POST /v1/share", "POST /v1/heartbeat", "POST /v1/invite", "POST /v1/adopt-network", "POST /v1/pair-action", "POST /v1/renew-certificate", "POST /v1/attempt", "POST /v1/lease", "POST /v1/end",
		"POST /v2/pairs/identity", "POST /v2/links/state", "POST /v2/candidates/prepare", "POST /v2/candidates/ready", "POST /v2/candidates/commit", "POST /v2/candidates/cancel", "POST /v2/candidates/state", "POST /v2/lease", "POST /v2/end":
		return true
	}
	return false
}

func (capture *serverAdmissionDiagnostics) Write(data []byte) (int, error) {
	capture.mu.Lock()
	defer capture.mu.Unlock()
	if capture.finished {
		// The owner calls finish only after cmd.Wait joins exec's stderr copier.
		// A test violating that owner cannot silently publish a complete receipt.
		capture.view.UnfinishedLines++
		return len(data), nil
	}
	for _, value := range data {
		if value == '\n' {
			if capture.overflow {
				capture.view.OverlongLines++
			} else {
				capture.recordLocked(string(capture.line))
			}
			clear(capture.line)
			capture.line = capture.line[:0]
			capture.overflow = false
			continue
		}
		if !capture.overflow {
			if len(capture.line) == admissionDiagnosticLineBytes {
				capture.overflow = true
			} else {
				capture.line = append(capture.line, value)
			}
		}
	}
	return len(data), nil
}

func (capture *serverAdmissionDiagnostics) recordLocked(line string) {
	if !strings.Contains(line, "[p2p] admission denied") {
		capture.view.IgnoredLines++
		return
	}
	fields := admissionDiagnosticPattern.FindStringSubmatch(line)
	if len(fields) != 9 || !admissionRegisteredRoute(fields[2], fields[3]) {
		capture.view.MalformedLines++
		return
	}
	var counts [3]uint32
	for index := range counts {
		parsed, err := strconv.ParseUint(fields[index+6], 10, 32)
		if err != nil {
			capture.view.MalformedLines++
			return
		}
		counts[index] = uint32(parsed)
	}
	record := serverAdmissionDiagnostic{Timestamp: fields[1], Method: fields[2], Route: fields[3], PrincipalKind: fields[4], Reason: fields[5], SourceCount: counts[0], GlobalCount: counts[1], SourceKeys: counts[2]}
	body, err := json.Marshal(record)
	if err != nil {
		capture.view.MalformedLines++
		return
	}
	// Reserve bounded space for the JSON array punctuation and loss counters.
	if capture.view.StoredBytes+len(body)+1 > admissionDiagnosticBytes-1024 {
		capture.view.DroppedRecords++
		return
	}
	capture.view.Records = append(capture.view.Records, record)
	capture.view.StoredBytes += len(body) + 1
}

func (capture *serverAdmissionDiagnostics) finish() serverAdmissionSnapshot {
	capture.mu.Lock()
	defer capture.mu.Unlock()
	if !capture.finished && (len(capture.line) != 0 || capture.overflow) {
		capture.view.UnfinishedLines++
		if capture.overflow {
			capture.view.OverlongLines++
		}
	}
	capture.finished = true
	clear(capture.line)
	capture.line = nil
	view := capture.view
	view.Records = append([]serverAdmissionDiagnostic{}, view.Records...)
	return view
}

func admissionTestLine(route, principal, reason string) string {
	return "2026/10/20 03:04:05 [p2p] admission denied method=GET route=" + route + " principalKind=" + principal + " reason=" + reason + " sourceCount=20 globalCount=41 sourceKeys=3\n"
}

func TestServerAdmissionDiagnosticsExactFragmentedSafeFields(t *testing.T) {
	capture := &serverAdmissionDiagnostics{}
	line := admissionTestLine("/v1/user", "ip", "source_limit")
	input := "server unrelated body/token must not be retained\n" + line
	for _, value := range []byte(input) {
		if count, err := capture.Write([]byte{value}); err != nil || count != 1 {
			t.Fatal("stderr write did not consume its bounded input", err)
		}
	}
	view := capture.finish()
	if len(view.Records) != 1 || view.IgnoredLines != 1 || view.MalformedLines != 0 || view.UnfinishedLines != 0 || view.DroppedRecords != 0 {
		t.Fatal("complete sampled diagnostic was lost or generic output was retained", view)
	}
	record := view.Records[0]
	if record.Method != "GET" || record.Route != "/v1/user" || record.PrincipalKind != "ip" || record.Reason != "source_limit" || record.SourceCount != 20 || record.GlobalCount != 41 || record.SourceKeys != 3 {
		t.Fatal("exact admission counters or route attribution changed", record)
	}
	body, _ := json.Marshal(view)
	if strings.Contains(string(body), "token") || strings.Contains(string(body), "unrelated") || view.StoredBytes <= 0 || view.StoredBytes > admissionDiagnosticBytes {
		t.Fatal("non-contract stderr escaped into the retained receipt")
	}
}

func TestServerAdmissionDiagnosticsRejectsMalformedAndIncomplete(t *testing.T) {
	capture := &serverAdmissionDiagnostics{}
	valid := admissionTestLine("/v1/user", "device", "source_limit")
	for _, line := range []string{
		strings.Replace(valid, "/v1/user", "/v1/users/secret-value", 1),
		strings.TrimSuffix(valid, "\n") + " token=private\n",
		strings.Replace(valid, "principalKind=device", "principalKind=untrusted", 1),
		strings.Replace(valid, "sourceCount=20", "sourceCount=4294967296", 1),
		strings.Replace(valid, "reason=source_limit", "reason=unknown", 1),
	} {
		_, _ = capture.Write([]byte(line))
	}
	_, _ = capture.Write([]byte(strings.Repeat("x", admissionDiagnosticLineBytes+1) + "\n"))
	_, _ = capture.Write([]byte(strings.TrimSuffix(valid, "\n")))
	view := capture.finish()
	if len(view.Records) != 0 || view.MalformedLines != 5 || view.OverlongLines != 1 || view.UnfinishedLines != 1 || view.StoredBytes != 0 {
		t.Fatal("malformed/truncated diagnostics were accepted as complete counters", view)
	}
	if after := capture.finish(); after.UnfinishedLines != view.UnfinishedLines {
		t.Fatal("finish counted the same trailing fragment twice")
	}
}

func TestServerAdmissionDiagnosticsPreservesAllFixedRefusalClasses(t *testing.T) {
	capture := &serverAdmissionDiagnostics{}
	for _, reason := range []string{"source_limit", "global_limit", "source_capacity", "invalid_remote_addr"} {
		for _, principal := range []string{"ip", "device"} {
			line := admissionTestLine("/v1/user", principal, reason)
			line = strings.Replace(line, "method=GET route=/v1/user", "method=POST route=/v2/candidates/prepare", 1)
			_, _ = capture.Write([]byte(line))
		}
	}
	view := capture.finish()
	if len(view.Records) != 8 || view.DroppedRecords != 0 || view.MalformedLines != 0 || view.UnfinishedLines != 0 {
		t.Fatal("fixed refusal classification was omitted or conflated", view)
	}
	for index, reason := range []string{"source_limit", "global_limit", "source_capacity", "invalid_remote_addr"} {
		for offset, principal := range []string{"ip", "device"} {
			record := view.Records[index*2+offset]
			if record.Method != "POST" || record.Route != "/v2/candidates/prepare" || record.PrincipalKind != principal || record.Reason != reason {
				t.Fatal("a discrete source/global/capacity/IP reason changed", record)
			}
		}
	}
}

func TestServerAdmissionDiagnosticsConcurrentBoundedAndLossVisible(t *testing.T) {
	capture := &serverAdmissionDiagnostics{}
	const workers, each = 8, 100
	var owner sync.WaitGroup
	for range workers {
		owner.Add(1)
		go func() {
			defer owner.Done()
			for range each {
				_, _ = capture.Write([]byte(admissionTestLine("/v1/networks", "device", "source_limit")))
			}
		}()
	}
	owner.Wait()
	view := capture.finish()
	if len(view.Records)+view.DroppedRecords != workers*each || view.DroppedRecords == 0 || view.StoredBytes > admissionDiagnosticBytes || view.MalformedLines != 0 || view.OverlongLines != 0 || view.UnfinishedLines != 0 {
		t.Fatal("bounded capture lost its sampled-record/drop accounting", len(view.Records), view)
	}
	body, err := json.Marshal(view)
	if err != nil || len(body) > admissionDiagnosticBytes {
		t.Fatal("full fixed-field diagnostic receipt exceeded 64KiB", len(body), err)
	}
}
