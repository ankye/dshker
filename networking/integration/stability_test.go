package integration

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"testing"
	"time"
)

func TestTwoPeerProcessLoadAndReconnect(t *testing.T) {
	f := newFixture(t)
	a, b := startChild(t, f.config[0]), startChild(t, f.config[1])
	connect(t, a, b, 1)
	baselineA, baselineB := a.call(t, command{Op: "status"}), b.call(t, command{Op: "status"})
	hashA, hashB := sha256.New(), sha256.New()
	started := time.Now()
	const rounds, batch, size = 64, 64, 16 * 1024
	for round := range rounds {
		dataA, dataB := bytes.Repeat([]byte{byte(round)}, size), bytes.Repeat([]byte{byte(round + 128)}, size)
		a.call(t, command{Op: "send", Data: dataA, Count: batch})
		b.call(t, command{Op: "send", Data: dataB, Count: batch})
		for range batch {
			hashA.Write(dataB)
			hashB.Write(dataA)
		}
		valueA, valueB := waitPackets(t, a, (round+1)*batch), waitPackets(t, b, (round+1)*batch)
		if valueA.Digest != hex.EncodeToString(hashA.Sum(nil)) || valueB.Digest != hex.EncodeToString(hashB.Sum(nil)) {
			t.Fatal("load payload order/hash mismatch")
		}
	}
	t.Logf("bidirectional load: %d bytes total, %d packets, exact order and SHA256 checked, elapsed=%s", 2*rounds*batch*size, 2*rounds*batch, time.Since(started))
	for _, c := range []*child{a, b} {
		bad := c.request(t, command{Op: "send", Data: make([]byte, 64*1024+1), Count: 1})
		if bad.Error != "p2p.send_limit" {
			t.Fatal("oversized payload was not explicitly rejected")
		}
		c.call(t, command{Op: "status"})
	}
	started = time.Now()
	for generation := uint64(2); generation <= 31; generation++ {
		a.call(t, command{Op: "disconnect"})
		b.call(t, command{Op: "close-local"})
		connect(t, a, b, generation)
		a.call(t, command{Op: "send", Data: []byte{byte(generation)}, Count: 1})
		waitPackets(t, b, rounds*batch+int(generation)-1)
	}
	for index, c := range []*child{a, b} {
		before := []result{baselineA, baselineB}[index]
		after := c.call(t, command{Op: "status"})
		// A bounded observation, not a proof of leak freedom. Race-build heap includes
		// Pion pools and GC slack; no forced GC is used to hide retained allocations.
		if after.Goroutines > before.Goroutines+12 || after.Heap > before.Heap+64*1024*1024 {
			t.Fatalf("resource growth beyond local test budget: goroutines %d -> %d, heap %d -> %d", before.Goroutines, after.Goroutines, before.Heap, after.Heap)
		}
		t.Logf("peer %d resources: goroutines %d -> %d, heap %d -> %d", index, before.Goroutines, after.Goroutines, before.Heap, after.Heap)
	}
	t.Logf("30 explicit disconnect/reconnect cycles passed; elapsed=%s", time.Since(started))
}

func TestTwoPeerProcessSoakAndServerLoss(t *testing.T) {
	f := newFixture(t)
	a, b := startChild(t, f.config[0]), startChild(t, f.config[1])
	attempt := connect(t, a, b, 1)
	started := time.Now()
	packets := 0
	// Cross at least four real 20-second renewals; no accelerated clock or fake lease.
	for time.Since(started) < 90*time.Second {
		data := []byte(fmt.Sprintf("soak-%06d", packets))
		a.call(t, command{Op: "send", Data: data, Count: 1})
		b.call(t, command{Op: "send", Data: data, Count: 1})
		packets++
		if !waitPackets(t, a, packets).ControlOnline || !waitPackets(t, b, packets).ControlOnline {
			t.Fatal("control WSS dropped during healthy soak")
		}
		time.Sleep(time.Second)
	}
	for _, c := range []*child{a, b} {
		c.wait(t, func(event result) bool { return event.Event == "renewed" && event.Attempt == attempt }, time.Second)
	}
	t.Logf("90-second live soak passed with %d bidirectional probes and real lease renewal", packets)
	lastA, lastB := a.call(t, command{Op: "status"}), b.call(t, command{Op: "status"})
	stopped := time.Now()
	f.server.stop(t, true)
	for _, c := range []*child{a, b} {
		c.wait(t, func(event result) bool { return event.Event == "control-offline" }, 5*time.Second)
	}
	// The control server is gone: bytes must still flow over the existing direct path.
	a.call(t, command{Op: "send", Data: []byte("server-is-offline"), Count: 1})
	waitPackets(t, b, packets+1)
	b.call(t, command{Op: "send", Data: []byte("server-is-offline"), Count: 1})
	waitPackets(t, a, packets+1)
	maxExpiry := max(lastA.Expires, lastB.Expires)
	for _, c := range []*child{a, b} {
		closed := c.wait(t, func(event result) bool { return event.Event == "closed" && event.Attempt == attempt }, time.Until(time.Unix(maxExpiry, 0))+3*time.Second)
		if closed.Error != "p2p.lease_expired" && closed.Error != "p2p.direct_closed" && closed.Error != "p2p.direct_unavailable" {
			t.Fatalf("unexpected expiration error: %s", closed.Error)
		}
		if time.Now().After(time.Unix(maxExpiry, 0).Add(3 * time.Second)) {
			t.Fatal("transport survived its authorization lease")
		}
		if c.request(t, command{Op: "send", Data: []byte("expired"), Count: 1}).Error == "" {
			t.Fatal("expired transport accepted payload")
		}
	}
	t.Logf("server kill: direct data still worked during valid lease; both peers closed after %s within signed expiry", time.Since(stopped))
	a.process.stop(t, true)
	b.process.stop(t, true)
	f.startServer(t)
	for i := range 2 {
		pin, err := f.devices[i].PairIdentity(f.ctx, f.config[i].Pin.Pair.PairID)
		must(t, err)
		if pin.Pair != f.config[i].Pin.Pair || pin.Initiator.Presence != "offline" || pin.Target.Presence != "offline" {
			t.Fatal("restart changed pair or revived stale presence")
		}
	}
	a, b = startChild(t, f.config[0]), startChild(t, f.config[1])
	connect(t, a, b, 2)
	t.Log("server restart retained pairing identity, required fresh presence, and reconnected explicitly")
}

func TestTwoPeerProcessSlowReceiverIsBounded(t *testing.T) {
	f := newFixture(t)
	a, b := startChild(t, f.config[0]), startChild(t, f.config[1])
	attempt := connect(t, a, b, 1)
	b.call(t, command{Op: "pause-reader"})
	// No receiver credit is implemented yet; verify the existing finite receive
	// queue fails explicitly rather than claiming full stream backpressure support.
	response := a.request(t, command{Op: "send", Data: make([]byte, 16*1024), Count: 128})
	if response.Error != "" && response.Error != "p2p.direct_closed" {
		t.Fatalf("unexpected sender failure: %s", response.Error)
	}
	closed := b.wait(t, func(event result) bool { return event.Event == "closed" && event.Attempt == attempt }, 5*time.Second)
	if closed.Error != "p2p.receive_limit" {
		t.Fatalf("unbounded or wrong receive failure: %s", closed.Error)
	}
	t.Log("paused receiver: finite 64-message queue closed with p2p.receive_limit; no silent drop or unlimited buffering")
}

func TestTwoPeerProcessAbruptLossAndRevocation(t *testing.T) {
	f := newFixture(t)
	a, b := startChild(t, f.config[0]), startChild(t, f.config[1])
	attempt := connect(t, a, b, 1)
	started := time.Now()
	b.process.stop(t, true)
	closed := a.wait(t, func(event result) bool { return event.Event == "closed" && event.Attempt == attempt }, 10*time.Second)
	if closed.Error == "" {
		t.Fatal("missing disconnection reason")
	}
	t.Logf("peer SIGKILL detected in %s; code=%s", time.Since(started), closed.Error)
	if a.request(t, command{Op: "send", Data: []byte("after-kill"), Count: 1}).Error == "" {
		t.Fatal("dead peer accepted payload")
	}
	a.call(t, command{Op: "disconnect"})
	b = startChild(t, f.config[1])
	attempt = connect(t, a, b, 2)
	started = time.Now()
	_, err := f.devices[0].PairAction(f.ctx, f.config[0].Pin.Pair.PairID, "revoke", "")
	must(t, err)
	for _, c := range []*child{a, b} {
		c.wait(t, func(event result) bool { return event.Event == "revoked" && event.Attempt == attempt }, 3*time.Second)
		if c.request(t, command{Op: "send", Data: []byte("revoked"), Count: 1}).Error == "" {
			t.Fatal("revoked peer accepted payload")
		}
	}
	if a.request(t, command{Op: "connect", Generation: 3}).Error != "p2p.pair_unauthorized" {
		t.Fatal("revoked pair reconnected")
	}
	t.Logf("active revocation closed both peers and blocked reconnect; elapsed=%s", time.Since(started))
}

func TestTwoPeerProcessConnectivity(t *testing.T) {
	f := newFixture(t)
	a, b := startChild(t, f.config[0]), startChild(t, f.config[1])
	if a.process.cmd.Process.Pid == b.process.cmd.Process.Pid {
		t.Fatal("peers share a process")
	}
	started := time.Now()
	connect(t, a, b, 1)
	data := []byte("real process A to process B through authenticated UDP/DTLS")
	a.call(t, command{Op: "send", Data: data, Count: 1})
	value := waitPackets(t, b, 1)
	digest := sha256.Sum256(data)
	if value.Bytes != len(data) || value.Digest != hex.EncodeToString(digest[:]) {
		t.Fatal("direct payload hash mismatch")
	}
	b.call(t, command{Op: "send", Data: data, Count: 1})
	if waitPackets(t, a, 1).Digest != value.Digest {
		t.Fatal("reverse direct payload hash mismatch")
	}
	t.Logf("coordinator PID=%d; peer PIDs=%d,%d; distinct devices; bidirectional hash verified; elapsed=%s", f.server.cmd.Process.Pid, a.process.cmd.Process.Pid, b.process.cmd.Process.Pid, time.Since(started))
}

func waitPackets(t *testing.T, c *child, expected int) result {
	t.Helper()
	for deadline := time.Now().Add(10 * time.Second); time.Now().Before(deadline); {
		value := c.call(t, command{Op: "status"})
		if value.Packets == expected {
			return value
		}
		if value.Packets > expected {
			t.Fatalf("duplicate delivery: got %d want %d", value.Packets, expected)
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal(fmt.Sprintf("delivery did not reach %d packets in 10 seconds", expected))
	return result{}
}
