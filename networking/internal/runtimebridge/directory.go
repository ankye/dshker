// Remote authorized roots and directory listing.
//
// Path normalization and containment checks run on the target computer using
// that computer's own filesystem rules, because only it can resolve drive
// letters, case-insensitivity, reserved names, Unicode forms, symlinks and
// junctions correctly. The initiator never rewrites separators or compares
// string prefixes, and it never receives a general file or shell capability:
// the only operations are listing an authorized root and resolving a project
// reference inside one.
package runtimebridge

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/ankye/dshker/networking/internal/peer"
	"github.com/ankye/dshker/networking/internal/protocol"
)

// maxDirectoryFrame bounds one control message on a directory stream.
const maxDirectoryFrame = 1 << 20

// MaxDirectoryEntries bounds one listing page so a huge directory cannot
// exhaust memory or stall the stream.
const MaxDirectoryEntries = 500

// Root is one directory the target user explicitly authorized.
type Root struct {
	RootID string `json:"rootId"`
	Name   string `json:"name"`
	Path   string `json:"path"`
}

// RootProvider is implemented by the target Launcher main process. It returns
// only roots the target user authorized; the initiator cannot add one.
type RootProvider func(context.Context) ([]Root, error)

// Entry is one directory child. Path is deliberately absent: the initiator
// receives an opaque reference and never a raw remote filesystem path.
type Entry struct {
	Ref         string `json:"ref"`
	Name        string `json:"name"`
	IsDirectory bool   `json:"isDirectory"`
	IsProject   bool   `json:"isProject"`
}

type directoryRequest struct {
	Version int    `json:"version"`
	Type    string `json:"type"`
	RootID  string `json:"rootId"`
	Ref     string `json:"ref"`
	Offset  int    `json:"offset"`
	Limit   int    `json:"limit"`
}

type directoryResponse struct {
	Version int     `json:"version"`
	Type    string  `json:"type"`
	Roots   []Root  `json:"roots"`
	Entries []Entry `json:"entries"`
	Total   int     `json:"total"`
	Error   string  `json:"error"`
}

// ServeDirectory answers one directory request stream on the target computer.
//
// Every reply is bounded and every path is resolved locally; a request that
// escapes its authorized root after symlink resolution is refused rather than
// silently clamped.
func ServeDirectory(ctx context.Context, stream *peer.Stream, roots RootProvider) error {
	if stream == nil {
		return errors.New("p2p.invalid_request")
	}
	defer stream.Close()
	data, err := readDirectoryFrame(ctx, stream)
	if err != nil {
		return err
	}
	var request directoryRequest
	if protocol.Decode(data, &request) != nil || request.Version != 1 {
		return replyDirectoryError(ctx, stream, "p2p.protocol_mismatch")
	}
	available, err := roots(ctx)
	if err != nil {
		return replyDirectoryError(ctx, stream, "p2p.remote_roots_unavailable")
	}
	switch request.Type {
	case "roots.list":
		return replyDirectory(ctx, stream, directoryResponse{Version: 1, Type: "roots.result", Roots: available})
	case "directory.list":
		entries, total, code := listDirectory(request, available)
		if code != "" {
			return replyDirectoryError(ctx, stream, code)
		}
		return replyDirectory(ctx, stream, directoryResponse{Version: 1, Type: "directory.result", Entries: entries, Total: total})
	}
	return replyDirectoryError(ctx, stream, "p2p.invalid_operation")
}

// listDirectory resolves the requested location and reads one bounded page.
func listDirectory(request directoryRequest, available []Root) ([]Entry, int, string) {
	root, found := findRoot(available, request.RootID)
	if !found {
		return nil, 0, "p2p.remote_root_unauthorized"
	}
	target, code := resolveWithin(root, request.Ref)
	if code != "" {
		return nil, 0, code
	}
	// Re-check containment after resolution: the directory may have been
	// replaced by a link since the reference was issued.
	if code := assertContained(root, target); code != "" {
		return nil, 0, code
	}
	children, err := os.ReadDir(target)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, 0, "p2p.remote_path_missing"
		}
		if os.IsPermission(err) {
			return nil, 0, "p2p.remote_path_forbidden"
		}
		return nil, 0, "p2p.remote_directory_failed"
	}
	names := make([]string, 0, len(children))
	kinds := map[string]bool{}
	for _, child := range children {
		if !child.IsDir() {
			continue
		}
		names = append(names, child.Name())
		kinds[child.Name()] = true
	}
	sort.Strings(names)
	limit := request.Limit
	if limit <= 0 || limit > MaxDirectoryEntries {
		limit = MaxDirectoryEntries
	}
	offset := request.Offset
	if offset < 0 || offset > len(names) {
		return nil, 0, "p2p.invalid_request"
	}
	end := offset + limit
	if end > len(names) {
		end = len(names)
	}
	page := make([]Entry, 0, end-offset)
	for _, name := range names[offset:end] {
		child := filepath.Join(target, name)
		page = append(page, Entry{
			Ref:         encodeRef(root.RootID, child),
			Name:        name,
			IsDirectory: true,
			IsProject:   isProjectDirectory(child),
		})
	}
	return page, len(names), ""
}

// resolveWithin turns an opaque reference into a real local path inside root.
func resolveWithin(root Root, ref string) (string, string) {
	if ref == "" {
		resolved, err := resolvePath(root.Path)
		if err != nil {
			return "", "p2p.remote_path_missing"
		}
		return resolved, ""
	}
	rootID, path, ok := decodeRef(ref)
	if !ok || rootID != root.RootID {
		return "", "p2p.remote_reference_invalid"
	}
	resolved, err := resolvePath(path)
	if err != nil {
		if os.IsNotExist(err) {
			return "", "p2p.remote_path_missing"
		}
		return "", "p2p.remote_path_forbidden"
	}
	return resolved, ""
}

// assertContained proves the resolved path really sits inside the resolved root
// using path semantics rather than a string prefix comparison.
func assertContained(root Root, target string) string {
	base, err := resolvePath(root.Path)
	if err != nil {
		return "p2p.remote_roots_unavailable"
	}
	relative, err := filepath.Rel(base, target)
	if err != nil {
		return "p2p.remote_path_forbidden"
	}
	if relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
		return "p2p.remote_path_forbidden"
	}
	return ""
}

func findRoot(available []Root, rootID string) (Root, bool) {
	for _, root := range available {
		if root.RootID == rootID {
			return root, true
		}
	}
	return Root{}, false
}

// isProjectDirectory reports whether a directory looks like a DSH project.
func isProjectDirectory(path string) bool {
	for _, marker := range []string{"project.json", "assets", "settings"} {
		if _, err := os.Stat(filepath.Join(path, marker)); err == nil {
			return true
		}
	}
	return false
}

// encodeRef produces the opaque reference the initiator holds. It carries the
// remote path so the target can resolve it later, and is meaningless to the
// initiator, which must never parse or construct one.
func encodeRef(rootID string, path string) string {
	payload, err := json.Marshal([]string{rootID, path})
	if err != nil {
		return ""
	}
	return base64.RawURLEncoding.EncodeToString(payload)
}

func decodeRef(ref string) (string, string, bool) {
	payload, err := base64.RawURLEncoding.DecodeString(ref)
	if err != nil {
		return "", "", false
	}
	var parts []string
	if json.Unmarshal(payload, &parts) != nil || len(parts) != 2 {
		return "", "", false
	}
	return parts[0], parts[1], true
}

// readDirectoryFrame reads one length-prefixed control message.
func readDirectoryFrame(ctx context.Context, stream *peer.Stream) ([]byte, error) {
	header := make([]byte, 4)
	if err := readFull(ctx, stream, header); err != nil {
		return nil, err
	}
	size := binary.BigEndian.Uint32(header)
	if size == 0 || size > maxDirectoryFrame {
		return nil, errors.New("p2p.protocol_limit")
	}
	body := make([]byte, size)
	if err := readFull(ctx, stream, body); err != nil {
		return nil, err
	}
	return body, nil
}

func readFull(ctx context.Context, stream *peer.Stream, target []byte) error {
	for filled := 0; filled < len(target); {
		read, err := stream.Read(ctx, target[filled:])
		if err != nil {
			return err
		}
		if read == 0 {
			return io.ErrUnexpectedEOF
		}
		filled += read
	}
	return nil
}

func replyDirectory(ctx context.Context, stream *peer.Stream, value directoryResponse) error {
	data, err := json.Marshal(value)
	if err != nil {
		return errors.New("p2p.protocol_mismatch")
	}
	if len(data) > maxDirectoryFrame {
		return errors.New("p2p.protocol_limit")
	}
	header := make([]byte, 4)
	binary.BigEndian.PutUint32(header, uint32(len(data)))
	if _, err := stream.Write(ctx, header); err != nil {
		return err
	}
	if _, err := stream.Write(ctx, data); err != nil {
		return err
	}
	return stream.CloseWrite()
}

func replyDirectoryError(ctx context.Context, stream *peer.Stream, code string) error {
	return replyDirectory(ctx, stream, directoryResponse{Version: 1, Type: "directory.error", Error: code})
}

// RequestRoots asks the target for the roots its user authorized.
func RequestRoots(ctx context.Context, mux *peer.Mux) ([]Root, error) {
	response, err := requestDirectory(ctx, mux, directoryRequest{Version: 1, Type: "roots.list"})
	if err != nil {
		return nil, err
	}
	if response.Type != "roots.result" {
		return nil, errors.New("p2p.protocol_mismatch")
	}
	return response.Roots, nil
}

// RequestDirectory reads one bounded page inside an authorized root.
//
// `ref` must be a reference previously issued by the target; the initiator never
// builds one from a path.
func RequestDirectory(ctx context.Context, mux *peer.Mux, rootID string, ref string, offset int, limit int) ([]Entry, int, error) {
	response, err := requestDirectory(ctx, mux, directoryRequest{Version: 1, Type: "directory.list", RootID: rootID, Ref: ref, Offset: offset, Limit: limit})
	if err != nil {
		return nil, 0, err
	}
	if response.Type != "directory.result" {
		return nil, 0, errors.New("p2p.protocol_mismatch")
	}
	return response.Entries, response.Total, nil
}

func requestDirectory(ctx context.Context, mux *peer.Mux, request directoryRequest) (directoryResponse, error) {
	var response directoryResponse
	if mux == nil {
		return response, errors.New("p2p.invalid_request")
	}
	stream, err := mux.Open()
	if err != nil {
		return response, err
	}
	defer stream.Close()
	data, err := json.Marshal(request)
	if err != nil {
		return response, errors.New("p2p.protocol_mismatch")
	}
	header := make([]byte, 4)
	binary.BigEndian.PutUint32(header, uint32(len(data)))
	if _, err := stream.Write(ctx, header); err != nil {
		return response, err
	}
	if _, err := stream.Write(ctx, data); err != nil {
		return response, err
	}
	if err := stream.CloseWrite(); err != nil {
		return response, err
	}
	body, err := readDirectoryFrame(ctx, stream)
	if err != nil {
		return response, err
	}
	if protocol.Decode(body, &response) != nil || response.Version != 1 {
		return response, errors.New("p2p.protocol_mismatch")
	}
	if response.Error != "" {
		return response, errors.New(response.Error)
	}
	return response, nil
}

// ServeDirectoryStreams answers directory requests for the lifetime of ctx.
//
// It runs on the target computer alongside the HTTP gateway and accepts one
// stream per request, so a slow or hostile listing cannot block the workbench
// proxy. A nil provider disables the capability entirely rather than exposing
// an empty root set that might read as "no restrictions".
func ServeDirectoryStreams(ctx context.Context, mux *peer.Mux, roots RootProvider) {
	if mux == nil || roots == nil {
		return
	}
	for {
		stream, err := mux.Accept(ctx)
		if err != nil {
			return
		}
		go ServeDirectory(ctx, stream, roots)
	}
}
