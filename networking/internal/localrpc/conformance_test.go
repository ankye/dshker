package localrpc

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"testing"
	"time"
)

const (
	readinessLine = "{\"version\":1,\"ready\":true}\n"
	authenticated = "{\"version\":1,\"authenticated\":true}\n"
)

var conformanceSecret = strings.Repeat("a", 64)

// fakeCore is the child half of the channel: it consumes one stdin bootstrap,
// publishes readiness, admits exactly one authenticated parent, and then serves
// frames. Both dshker-peer and dshkerd behave this way.
type fakeCore struct {
	conn net.Conn
	err  error
}

func startFakeCore(ctx context.Context, bootstrap string, ready io.Writer) <-chan fakeCore {
	result := make(chan fakeCore, 1)
	go func() {
		conn, err := AcceptMain(ctx, strings.NewReader(bootstrap), ready)
		result <- fakeCore{conn, err}
	}()
	return result
}

func bootstrapRecord(endpoint, secret string) string {
	data, err := json.Marshal(Bootstrap{Version: 1, Socket: endpoint, Secret: secret})
	if err != nil {
		panic(err)
	}
	return string(data)
}

type admitted struct {
	parent   *Peer
	core     *Peer
	endpoint string
}

// admitCore runs the handshake the shell performs, then returns both ends
// wrapped in peers so either side can call the other.
func admitCore(t *testing.T, ctx context.Context) admitted {
	t.Helper()
	endpoint := testEndpoint(t)
	ready, output := io.Pipe()
	t.Cleanup(func() { ready.Close(); output.Close() })
	result := startFakeCore(ctx, bootstrapRecord(endpoint, conformanceSecret), output)
	line, err := bufio.NewReader(ready).ReadString('\n')
	if err != nil || line != readinessLine {
		t.Fatalf("bootstrap readiness: %q %v", line, err)
	}
	conn, err := dialPrivate(endpoint)
	if err != nil {
		t.Fatalf("dial private endpoint: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	if err = authenticate(conn, conformanceSecret); err != nil {
		t.Fatalf("authenticate: %v", err)
	}
	core := <-result
	if core.err != nil {
		t.Fatalf("core bootstrap: %v", core.err)
	}
	t.Cleanup(func() { core.conn.Close() })
	parent := New(ctx, conn, refuseEveryCallback)
	t.Cleanup(parent.Close)
	corePeer := New(ctx, core.conn, echoOrRefuse)
	t.Cleanup(corePeer.Close)
	return admitted{parent: parent, core: corePeer, endpoint: endpoint}
}

func authenticate(conn net.Conn, secret string) error {
	conn.SetDeadline(time.Now().Add(5 * time.Second))
	line, err := json.Marshal(Authentication{Version: 1, Secret: secret})
	if err != nil {
		return err
	}
	if _, err = conn.Write(append(line, '\n')); err != nil {
		return err
	}
	acknowledgement := make([]byte, len(authenticated))
	if _, err = io.ReadFull(conn, acknowledgement); err != nil {
		return err
	}
	if string(acknowledgement) != authenticated {
		return fmt.Errorf("unexpected acknowledgement %q", acknowledgement)
	}
	conn.SetDeadline(time.Time{})
	return nil
}

func echoOrRefuse(_ context.Context, method string, payload json.RawMessage) (any, error) {
	if method == "core.echo" {
		return json.RawMessage(payload), nil
	}
	return nil, errors.New("p2p.invalid_operation")
}

func refuseEveryCallback(context.Context, string, json.RawMessage) (any, error) {
	return nil, errors.New("p2p.invalid_operation")
}

func TestConformanceCallAndRefusal(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	channel := admitCore(t, ctx)
	payload, err := channel.parent.Call(ctx, "core.echo", map[string]string{"value": "hello"})
	if err != nil {
		t.Fatalf("echo call: %v", err)
	}
	if string(payload) != "{\"value\":\"hello\"}" {
		t.Fatalf("echo payload: %s", payload)
	}
	if _, err = channel.parent.Call(ctx, "core.missing", struct{}{}); err == nil || err.Error() != "p2p.invalid_operation" {
		t.Fatalf("unknown method was not refused: %v", err)
	}
	// A refusal must not poison the channel: a later call still works, and a
	// callback still travels the other way.
	if _, err = channel.parent.Call(ctx, "core.echo", struct{}{}); err != nil {
		t.Fatalf("call after a refusal: %v", err)
	}
	if _, err = channel.core.Call(ctx, "peer.state", struct{}{}); err == nil || err.Error() != "p2p.invalid_operation" {
		t.Fatalf("callback was not refused by the shell: %v", err)
	}
}

// A second client that never received the bootstrap must not be admitted: the
// listener is closed after the single Accept.
func TestConformanceSecondClientIsRefused(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	channel := admitCore(t, ctx)
	conn, err := dialPrivate(channel.endpoint)
	if err != nil {
		return
	}
	conn.Close()
	t.Fatal("an unbootstrapped second client was admitted")
}

func TestConformanceForeignBootstrapVersion(t *testing.T) {
	records := map[string]string{
		"version":        "{\"version\":2,\"socket\":" + quote("ENDPOINT") + ",\"secret\":" + quote(conformanceSecret) + "}",
		"missing-secret": "{\"version\":1,\"socket\":" + quote("ENDPOINT") + "}",
		"short-secret":   "{\"version\":1,\"socket\":" + quote("ENDPOINT") + ",\"secret\":\"abcd\"}",
	}
	for name, record := range records {
		t.Run(name, func(t *testing.T) {
			endpoint := testEndpoint(t)
			record = strings.Replace(record, quote("ENDPOINT"), quote(endpoint), 1)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			ready, output := io.Pipe()
			defer ready.Close()
			result := startFakeCore(ctx, record, output)
			core := <-result
			output.Close()
			if core.conn != nil || core.err == nil || core.err.Error() != "p2p.invalid_bootstrap" {
				t.Fatalf("bootstrap %q was not refused: %v", name, core.err)
			}
			if line, err := bufio.NewReader(ready).ReadString('\n'); err != io.EOF || line != "" {
				t.Fatalf("a refused bootstrap published readiness: %q %v", line, err)
			}
		})
	}
}

func TestConformanceWrongSecretIsRefused(t *testing.T) {
	endpoint := testEndpoint(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ready, output := io.Pipe()
	defer ready.Close()
	defer output.Close()
	result := startFakeCore(ctx, bootstrapRecord(endpoint, conformanceSecret), output)
	if line, err := bufio.NewReader(ready).ReadString('\n'); err != nil || line != readinessLine {
		t.Fatalf("bootstrap readiness: %q %v", line, err)
	}
	conn, err := dialPrivate(endpoint)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err = authenticate(conn, strings.Repeat("b", 64)); err == nil {
		t.Fatal("a wrong secret was accepted")
	}
	core := <-result
	if core.conn != nil || core.err == nil || core.err.Error() != "p2p.helper_authentication_failed" {
		t.Fatalf("authentication failure code: %v", core.err)
	}
}

// A frame with a foreign version terminates the channel instead of being
// interpreted.
func TestConformanceForeignFrameVersionTerminates(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	channel := admitCore(t, ctx)
	if _, err := channel.parent.conn.Write([]byte("{\"version\":2,\"id\":1,\"method\":\"core.echo\",\"payload\":{},\"error\":\"\"}\n")); err != nil {
		t.Fatalf("write foreign frame: %v", err)
	}
	select {
	case <-channel.parent.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("a foreign frame version did not terminate the channel")
	}
}

func quote(value string) string {
	data, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return string(data)
}
