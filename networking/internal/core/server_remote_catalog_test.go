package core

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/ankye/dshker/networking/internal/remoteconnections"
)

func remoteCatalogFile(t *testing.T) string {
	t.Helper()
	directory := filepath.Join(t.TempDir(), "dsh-launcher")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	return filepath.Join(directory, remoteconnections.FileName)
}

func remoteCatalogPayload(t *testing.T, value any) json.RawMessage {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

// TestRemoteCatalogThroughTheCore drives the four catalog operations the shell
// reaches over the private channel, including the stale-edit refusal the page
// depends on.
func TestRemoteCatalogThroughTheCore(t *testing.T) {
	filePath := remoteCatalogFile(t)
	ctx := context.Background()

	// A first read publishes an empty catalog rather than failing.
	inspected, err := Handle(ctx, "remote.catalog_inspect", remoteCatalogPayload(t, struct {
		FilePath string `json:"filePath"`
	}{filePath}))
	if err != nil {
		t.Fatalf("inspect: %v", err)
	}
	if result, ok := inspected.(remoteCatalogResult); !ok || len(result.Connections) != 0 {
		t.Fatalf("inspect = %+v", inspected)
	}

	created, err := Handle(ctx, "remote.catalog_create", remoteCatalogPayload(t, struct {
		FilePath    string `json:"filePath"`
		DisplayName string `json:"displayName"`
		Host        string `json:"host"`
		Port        int    `json:"port"`
		User        string `json:"user"`
	}{filePath, "Build box", "build.example", 22, "deploy"}))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	result, ok := created.(remoteCatalogResult)
	if !ok || len(result.Connections) != 1 || result.Connections[0].ConfigRevision == "" {
		t.Fatalf("create = %+v", created)
	}
	connection := result.Connections[0]

	// A stale revision is refused by name, and a fresh one is accepted.
	update := struct {
		FilePath               string `json:"filePath"`
		ConnectionID           string `json:"connectionId"`
		DisplayName            string `json:"displayName"`
		Host                   string `json:"host"`
		Port                   int    `json:"port"`
		User                   string `json:"user"`
		ExpectedConfigRevision string `json:"expectedConfigRevision"`
	}{filePath, connection.ConnectionID, "Build box two", "build.example", 2222, "deploy", "stale"}
	if _, err := Handle(ctx, "remote.catalog_update", remoteCatalogPayload(t, update)); !errors.Is(err, remoteconnections.ErrConfigConflict) {
		t.Fatalf("stale update = %v", err)
	}
	update.ExpectedConfigRevision = connection.ConfigRevision
	update.DisplayName = "Build box two"
	updated, err := Handle(ctx, "remote.catalog_update", remoteCatalogPayload(t, update))
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if view, ok := updated.(remoteCatalogResult); !ok || view.Connections[0].DisplayName != "Build box two" {
		t.Fatalf("update = %+v", updated)
	}

	removed, err := Handle(ctx, "remote.catalog_remove", remoteCatalogPayload(t, struct {
		FilePath     string `json:"filePath"`
		ConnectionID string `json:"connectionId"`
	}{filePath, connection.ConnectionID}))
	if err != nil {
		t.Fatalf("remove: %v", err)
	}
	if view, ok := removed.(remoteCatalogResult); !ok || len(view.Connections) != 0 {
		t.Fatalf("remove = %+v", removed)
	}

	// The path is not a caller's choice: only the one file name is owned.
	if _, err := Handle(ctx, "remote.catalog_inspect", remoteCatalogPayload(t, struct {
		FilePath string `json:"filePath"`
	}{filepath.Join(filepath.Dir(filePath), "connections.json")})); !errors.Is(err, remoteconnections.ErrPersistenceFailed) {
		t.Fatalf("another file name = %v", err)
	}
}
