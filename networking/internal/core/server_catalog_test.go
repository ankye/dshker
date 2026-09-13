package core

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/ankye/dshker/networking/internal/catalog"
)

// newCatalogServe wires a real store over a temporary directory. The record's
// own validation is covered by internal/catalog; these tests are about the
// adapter the shell talks to.
func newCatalogServe(t *testing.T) Serve {
	t.Helper()
	store, err := catalog.Open(t.TempDir())
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	return Serve{Catalog: store}
}

func callCatalog(t *testing.T, server Serve, method string, payload string) (catalogResult, error) {
	t.Helper()
	result, err := server.Handle(context.Background(), method, json.RawMessage(payload))
	if err != nil {
		return catalogResult{}, err
	}
	rendered, ok := result.(catalogResult)
	if !ok {
		t.Fatalf("%s returned %T", method, result)
	}
	return rendered, nil
}

// Before the user enables anything the shell has to be able to tell "nothing
// stored" apart from a failure, or it cannot offer to enable.
func TestCatalogInspectReportsNeverEnabled(t *testing.T) {
	server := newCatalogServe(t)
	result, err := callCatalog(t, server, "core.catalog_inspect", "{}")
	if err != nil {
		t.Fatalf("inspect: %v", err)
	}
	if result.Enabled || result.Record != nil || result.Revision != "" {
		t.Fatalf("a fresh directory reported %+v", result)
	}
}

func TestCatalogEnableThenInspect(t *testing.T) {
	server := newCatalogServe(t)
	enabled, err := callCatalog(t, server, "core.catalog_enable", "{}")
	if err != nil {
		t.Fatalf("enable: %v", err)
	}
	if !enabled.Enabled || enabled.Record == nil || enabled.Revision == "" {
		t.Fatalf("enable returned %+v", enabled)
	}
	if enabled.Record.CatalogID == "" || len(enabled.Record.Services) != 0 {
		t.Fatalf("a fresh catalog is not empty: %+v", enabled.Record)
	}

	inspected, err := callCatalog(t, server, "core.catalog_inspect", "{}")
	if err != nil {
		t.Fatalf("inspect: %v", err)
	}
	if !inspected.Enabled || inspected.Revision != enabled.Revision {
		t.Fatalf("inspect disagrees with enable: %+v vs %+v", inspected, enabled)
	}

	// Enabling twice must not erase the first catalog.
	if _, err := callCatalog(t, server, "core.catalog_enable", "{}"); !errors.Is(err, catalog.ErrExists) {
		t.Fatalf("second enable = %v, want %v", err, catalog.ErrExists)
	}
}

// The revision is the shell's concurrency token, so the adapter has to pass it
// through untouched and refuse a stale one.
func TestCatalogCommitCarriesTheRevision(t *testing.T) {
	server := newCatalogServe(t)
	enabled, err := callCatalog(t, server, "core.catalog_enable", "{}")
	if err != nil {
		t.Fatalf("enable: %v", err)
	}

	unchanged, err := callCatalog(t, server, "core.catalog_commit", `{"expectedRevision":"`+enabled.Revision+`","record":`+renderRecord(t, enabled)+`}`)
	if err != nil {
		t.Fatalf("commit: %v", err)
	}
	if unchanged.Revision != enabled.Revision {
		t.Fatalf("an unchanged commit moved the revision %s -> %s", enabled.Revision, unchanged.Revision)
	}

	if _, err := callCatalog(t, server, "core.catalog_commit", `{"expectedRevision":"deadbeef","record":`+renderRecord(t, enabled)+`}`); !errors.Is(err, catalog.ErrConflict) {
		t.Fatalf("stale revision = %v, want %v", err, catalog.ErrConflict)
	}
}

func TestCatalogRemoveServiceReportsAnAbsentService(t *testing.T) {
	server := newCatalogServe(t)
	if _, err := callCatalog(t, server, "core.catalog_enable", "{}"); err != nil {
		t.Fatalf("enable: %v", err)
	}
	absent := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	if _, err := callCatalog(t, server, "core.catalog_remove_service", `{"serviceId":"`+absent+`"}`); !errors.Is(err, catalog.ErrServiceNotFound) {
		t.Fatalf("absent service = %v, want %v", err, catalog.ErrServiceNotFound)
	}
}

// A core without a catalog directory must refuse rather than answer an empty
// catalog, which the shell would render as "everything was forgotten".
func TestCatalogMethodsRefuseWithoutAStore(t *testing.T) {
	cases := map[string]string{
		"core.catalog_inspect":        "{}",
		"core.catalog_enable":         "{}",
		"core.catalog_commit":         `{"expectedRevision":"x","record":{}}`,
		"core.catalog_remove_service": `{"serviceId":"a"}`,
	}
	for method, payload := range cases {
		if _, err := (Serve{}).Handle(context.Background(), method, json.RawMessage(payload)); !errors.Is(err, catalog.ErrUnavailable) {
			t.Fatalf("%s without a store = %v, want %v", method, err, catalog.ErrUnavailable)
		}
	}
}

func TestCatalogMethodsRefuseMalformedPayloads(t *testing.T) {
	cases := map[string]string{
		"core.catalog_inspect":        `{"extra":true}`,
		"core.catalog_enable":         `{"extra":true}`,
		"core.catalog_commit":         `{"expectedRevision":"x"}`,
		"core.catalog_remove_service": `{}`,
	}
	for method, payload := range cases {
		if _, err := (Serve{}).Handle(context.Background(), method, json.RawMessage(payload)); err == nil {
			t.Fatalf("%s accepted %s", method, payload)
		}
	}
}

func TestCatalogMethodsArePublished(t *testing.T) {
	published := make(map[string]bool)
	for _, name := range MethodTable() {
		published[name] = true
	}
	for _, name := range []string{"core.catalog_commit", "core.catalog_enable", "core.catalog_inspect", "core.catalog_remove_service"} {
		if !published[name] {
			t.Errorf("%s is not listed by MethodTable", name)
		}
	}
}

// renderRecord re-encodes the snapshot's record for a commit payload.
func renderRecord(t *testing.T, snapshot catalogResult) string {
	t.Helper()
	raw, err := json.Marshal(snapshot.Record)
	if err != nil {
		t.Fatalf("marshal record: %v", err)
	}
	return string(raw)
}
