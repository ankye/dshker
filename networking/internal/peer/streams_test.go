package peer

import (
	"bytes"
	"context"
	"errors"
	"io"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/protocol"
)

func streamPair(t *testing.T) (context.Context, *Mux, *Mux) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	t.Cleanup(cancel)
	a, b := optionsPair(t)
	first, err := NewTransport(ctx, a)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { first.Close() })
	second, err := NewTransport(ctx, b)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { second.Close() })
	offer, err := first.Offer(ctx)
	if err != nil {
		t.Fatal(err)
	}
	answer, err := second.AcceptOffer(ctx, offer)
	if err != nil {
		t.Fatal(err)
	}
	if err := first.AcceptAnswer(answer); err != nil {
		t.Fatal(err)
	}
	for _, transport := range []*Transport{first, second} {
		if err := transport.WaitReady(ctx); err != nil {
			t.Fatal(err)
		}
	}
	scope := StreamScope{AttemptID: a.Scope.AttemptID, Generation: a.Scope.Generation, RuntimeGeneration: 1, Initiator: true}
	left, err := NewMux(first, scope)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { left.Close() })
	scope.Initiator = false
	right, err := NewMux(second, scope)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { right.Close() })
	return ctx, left, right
}

func TestMuxDirectStreamCreditHalfCloseAndReverse(t *testing.T) {
	ctx, left, right := streamPair(t)
	sender, err := left.Open()
	if err != nil {
		t.Fatal(err)
	}
	receiver, err := right.Accept(ctx)
	if err != nil || receiver.ID() != sender.ID() {
		t.Fatal("stream ownership mismatch", err)
	}
	// No receiver reads: the actual Pion sender must block at exactly 128 KiB.
	slowCtx, cancel := context.WithTimeout(ctx, 150*time.Millisecond)
	defer cancel()
	content := bytes.Repeat([]byte("0123456789abcdef"), protocol.StreamWindowBytes/16+1)
	written, err := sender.Write(slowCtx, content)
	if !errors.Is(err, context.DeadlineExceeded) || written != protocol.StreamWindowBytes {
		t.Fatalf("slow-reader credit: wrote %d, error %v", written, err)
	}
	if err := sender.CloseWrite(); err != nil {
		t.Fatal(err)
	}
	var actual []byte
	buffer := make([]byte, 7001)
	for {
		n, err := receiver.Read(ctx, buffer)
		actual = append(actual, buffer[:n]...)
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	if !bytes.Equal(actual, content[:written]) {
		t.Fatal("half-close discarded or reordered bytes")
	}
	response := []byte("reverse after FIN")
	if n, err := receiver.Write(ctx, response); err != nil || n != len(response) {
		t.Fatal(n, err)
	}
	if err := receiver.CloseWrite(); err != nil {
		t.Fatal(err)
	}
	n, err := sender.Read(ctx, buffer)
	if err != nil || !bytes.Equal(buffer[:n], response) {
		t.Fatal("reverse direction broken", err)
	}
	if n, err = sender.Read(ctx, buffer); n != 0 || err != io.EOF {
		t.Fatal("missing reverse EOF", n, err)
	}
	left.mu.Lock()
	remaining := len(left.streams)
	left.mu.Unlock()
	if remaining != 0 {
		t.Fatal("completed stream reservation leaked")
	}
}

func TestMuxDirectLargeTransferWrapsRingAndRecoversAfterReset(t *testing.T) {
	ctx, left, right := streamPair(t)
	first, err := left.Open()
	if err != nil {
		t.Fatal(err)
	}
	other, err := right.Accept(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := other.Read(ctx, make([]byte, 1)); err == nil {
		t.Fatal("RESET did not interrupt read")
	}
	sender, err := right.Open()
	if err != nil {
		t.Fatal(err)
	}
	receiver, err := left.Accept(ctx)
	if err != nil || sender.ID()%2 != 0 || receiver.ID() != sender.ID() {
		t.Fatal("reverse stream identity", err)
	}
	content := make([]byte, 4*1024*1024+37)
	for index := range content {
		content[index] = byte(index*13 + index/65537)
	}
	finished := make(chan error, 1)
	go func() {
		n, err := sender.Write(ctx, content)
		if err == nil && n != len(content) {
			err = io.ErrShortWrite
		}
		if err == nil {
			err = sender.CloseWrite()
		}
		finished <- err
	}()
	actual := make([]byte, 0, len(content))
	buffer := make([]byte, 7907)
	for {
		n, err := receiver.Read(ctx, buffer)
		actual = append(actual, buffer[:n]...)
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	if err := <-finished; err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(actual, content) {
		t.Fatal("ring wrap corrupted actual direct bytes")
	}
	if err := receiver.CloseWrite(); err != nil {
		t.Fatal(err)
	}
}

func TestMuxStreamLimitAndIndependentReset(t *testing.T) {
	ctx, left, right := streamPair(t)
	var streams []*Stream
	for range protocol.MaxStreams {
		stream, err := left.Open()
		if err != nil {
			t.Fatal(err)
		}
		remote, err := right.Accept(ctx)
		if err != nil || remote.ID() != stream.ID() {
			t.Fatal("wrong admitted stream", err)
		}
		streams = append(streams, stream)
	}
	if _, err := left.Open(); err == nil {
		t.Fatal("65th stream accepted")
	}
	if err := streams[0].Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := streams[1].Write(ctx, []byte("unaffected")); err != nil {
		t.Fatal("RESET closed unrelated stream", err)
	}
	left.mu.Lock()
	reserved := 0
	for _, stream := range left.streams {
		reserved += cap(stream.queue)
	}
	left.mu.Unlock()
	if reserved != (protocol.MaxStreams-1)*protocol.StreamWindowBytes {
		t.Fatal("incorrect fixed reservations", reserved)
	}
	if err := left.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := streams[1].Write(ctx, []byte("closed")); err == nil {
		t.Fatal("write accepted after shutdown")
	}
}
