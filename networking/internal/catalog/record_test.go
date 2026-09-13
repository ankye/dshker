package catalog

import (
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

// validRecord builds the smallest record the parser accepts.
func validRecord(t *testing.T) Record {
	t.Helper()
	service := newService(t, "Coordinator")
	return Record{
		Format:              recordFormat,
		Version:             1,
		CatalogID:           randomID(t),
		Services:            []Service{service},
		Computers:           []Computer{newComputer(t, service)},
		ForgottenServiceIDs: []string{},
	}
}

func encoded(t *testing.T, record Record) []byte {
	t.Helper()
	raw, err := json.Marshal(record)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return raw
}

func TestParseAcceptsAWellFormedRecord(t *testing.T) {
	record := validRecord(t)
	parsed, err := Parse(encoded(t, record))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if parsed.CatalogID != record.CatalogID || len(parsed.Services) != 1 || len(parsed.Computers) != 1 {
		t.Fatalf("round trip changed the record: %+v", parsed)
	}
	if parsed.Format != recordFormat || parsed.Version != 1 {
		t.Fatalf("round trip changed the header: %+v", parsed)
	}
}

// The shell writes and reads this same file, so the field names have to be
// exactly what catalog.ts produces. A rename here would silently split the two
// implementations, and only a byte-level check catches that.
func TestWireFormatMatchesTheShell(t *testing.T) {
	var decoded map[string]any
	if err := json.Unmarshal(encoded(t, validRecord(t)), &decoded); err != nil {
		t.Fatalf("json: %v", err)
	}
	for _, key := range []string{"format", "version", "catalogId", "services", "computers", "forgottenServiceIds"} {
		if _, ok := decoded[key]; !ok {
			t.Fatalf("top level is missing %q: %v", key, fieldNames(decoded))
		}
	}
	if len(decoded) != 6 {
		t.Fatalf("unexpected top-level fields: %v", fieldNames(decoded))
	}
	services, ok := decoded["services"].([]any)
	if !ok || len(services) != 1 {
		t.Fatalf("services is not one entry: %v", decoded["services"])
	}
	service, _ := services[0].(map[string]any)
	for _, key := range []string{"serviceId", "displayName", "httpsOrigin", "wssUrl", "stunAddress", "publicKey", "certificate"} {
		if _, ok := service[key]; !ok {
			t.Fatalf("service is missing %q: %v", key, fieldNames(service))
		}
	}
	computers, ok := decoded["computers"].([]any)
	if !ok || len(computers) != 1 {
		t.Fatalf("computers is not one entry: %v", decoded["computers"])
	}
	computer, _ := computers[0].(map[string]any)
	for _, key := range []string{"connectionId", "serviceId", "displayName", "pairId", "networkId", "localDeviceId", "remoteDeviceId", "userId", "localPublicKey", "remotePublicKey", "pairRevision", "pairState"} {
		if _, ok := computer[key]; !ok {
			t.Fatalf("computer is missing %q: %v", key, fieldNames(computer))
		}
	}
}

func fieldNames(record map[string]any) []string {
	names := make([]string, 0, len(record))
	for name := range record {
		names = append(names, name)
	}
	return names
}

// Every mutation below is something a corrupt or hostile file could contain.
func TestParseRefusesMalformedRecords(t *testing.T) {
	base := validRecord(t)
	for name, mutate := range map[string]func(*Record){
		"format":       func(r *Record) { r.Format = "dshker.other" },
		"version":      func(r *Record) { r.Version = 2 },
		"catalog id":   func(r *Record) { r.CatalogID = "short" },
		"service id":   func(r *Record) { r.Services[0].ServiceID = strings.Repeat("a", 64) },
		"service name": func(r *Record) { r.Services[0].DisplayName = " padded " },
		"empty name":   func(r *Record) { r.Services[0].DisplayName = "" },
		"service key":  func(r *Record) { r.Services[0].PublicKey = base64.StdEncoding.EncodeToString(make([]byte, 32)) },
		"certificate": func(r *Record) {
			r.Services[0].Certificate = base64.StdEncoding.EncodeToString([]byte("not a certificate"))
		},
		"plaintext origin":  func(r *Record) { r.Services[0].HTTPSOrigin = "http://coordinator.example:8443" },
		"origin with path":  func(r *Record) { r.Services[0].HTTPSOrigin = "https://coordinator.example:8443/" },
		"wss host":          func(r *Record) { r.Services[0].WSSURL = "wss://elsewhere.example:8443/v1/signals" },
		"wss path":          func(r *Record) { r.Services[0].WSSURL = "wss://coordinator.example:8443/other" },
		"stun without port": func(r *Record) { r.Services[0].STUNAddress = "coordinator.example" },
		"stun with space":   func(r *Record) { r.Services[0].STUNAddress = "coordinator.example:34 78" },
		"unknown service":   func(r *Record) { r.Computers[0].ServiceID = strings.Repeat("b", 64) },
		"computer revision": func(r *Record) { r.Computers[0].PairRevision = 0 },
		"computer state":    func(r *Record) { r.Computers[0].PairState = "pending" },
		"identical devices": func(r *Record) { r.Computers[0].RemoteDeviceID = r.Computers[0].LocalDeviceID },
		"identical keys":    func(r *Record) { r.Computers[0].RemotePublicKey = r.Computers[0].LocalPublicKey },
		"connection id":     func(r *Record) { r.Computers[0].ConnectionID = "zz" },
		"forgotten id":      func(r *Record) { r.ForgottenServiceIDs = []string{"not-hex"} },
	} {
		t.Run(name, func(t *testing.T) {
			record := base
			record.Services = append([]Service(nil), base.Services...)
			record.Computers = append([]Computer(nil), base.Computers...)
			mutate(&record)
			if _, err := Parse(encoded(t, record)); err == nil {
				t.Fatal("accepted a malformed record")
			}
		})
	}
}

func TestParseRefusesDuplicatesUnknownFieldsAndOversizedInput(t *testing.T) {
	base := validRecord(t)

	duplicated := base
	duplicated.Services = []Service{base.Services[0], base.Services[0]}
	if _, err := Parse(encoded(t, duplicated)); err == nil {
		t.Fatal("accepted a duplicated service")
	}

	duplicatedComputer := base
	duplicatedComputer.Computers = []Computer{base.Computers[0], base.Computers[0]}
	if _, err := Parse(encoded(t, duplicatedComputer)); err == nil {
		t.Fatal("accepted a duplicated computer")
	}

	unknown := strings.Replace(string(encoded(t, base)), "\"version\":1", "\"version\":1,\"extra\":true", 1)
	if _, err := Parse([]byte(unknown)); err == nil {
		t.Fatal("accepted an unknown field")
	}

	if _, err := Parse(make([]byte, MaxRecordBytes+1)); err == nil {
		t.Fatal("accepted an oversized record")
	}
	if _, err := Parse(nil); err == nil {
		t.Fatal("accepted an empty record")
	}
}

func TestParseRefusesADanglingComputer(t *testing.T) {
	record := validRecord(t)
	record.Computers = []Computer{newComputer(t, newService(t, "Other"))}
	if _, err := Parse(encoded(t, record)); err == nil {
		t.Fatal("accepted a computer whose service is absent")
	}
}
