package runtimebridge

import (
	"net"
	"net/http"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/peer"
)

func TestPromotionRetiresOnlyOldIngressCohort(t *testing.T) {
	_, oldMux, _ := directMuxes(t)
	_, nextMux, _ := directMuxes(t)
	binding := Binding{Generation: 7, URL: "http://127.0.0.1:1/?token=cohort-test"}
	endpoint, err := NewEndpoint(oldMux, binding)
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	gateway := &Gateway{transport: &http.Transport{}, attachment: endpoint, sockets: make(map[net.Conn]*peer.Mux)}
	tracked := &trackedListener{Listener: listener, owner: gateway}
	oldClient, err := net.Dial("tcp4", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer oldClient.Close()
	oldServer, err := tracked.Accept()
	if err != nil {
		t.Fatal(err)
	}
	defer oldServer.Close()
	entered, release := make(chan struct{}), make(chan struct{})
	endpoint.onDetach = func(expected *peer.Mux) {
		close(entered)
		<-release
		gateway.dropCohort(expected)
	}
	promoted := make(chan error, 1)
	go func() { promoted <- endpoint.Replace(nextMux, binding) }()
	<-entered
	nextClient, err := net.Dial("tcp4", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer nextClient.Close()
	accepted := make(chan net.Conn, 1)
	go func() { conn, _ := tracked.Accept(); accepted <- conn }()
	close(release)
	if err := <-promoted; err != nil {
		t.Fatal(err)
	}
	var nextServer net.Conn
	select {
	case nextServer = <-accepted:
	case <-time.After(time.Second):
		t.Fatal("new ingress remained blocked after promotion")
	}
	if nextServer == nil {
		t.Fatal("new ingress was refused")
	}
	defer nextServer.Close()
	gateway.mu.Lock()
	cohort := gateway.sockets[nextServer]
	gateway.mu.Unlock()
	if cohort != nextMux {
		t.Fatal("new ingress inherited the retired cohort")
	}
	oldClient.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := oldClient.Read(make([]byte, 1)); err == nil {
		t.Fatal("retired ingress remained open")
	}
	written := make(chan error, 1)
	go func() { _, err := nextClient.Write([]byte("x")); written <- err }()
	nextServer.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := nextServer.Read(make([]byte, 1)); err != nil {
		t.Fatalf("promotion closed new ingress: %v", err)
	}
	if err := <-written; err != nil {
		t.Fatal(err)
	}
}
