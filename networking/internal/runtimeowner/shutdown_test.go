package runtimeowner

import (
	"context"
	"net"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/localrpc"
)

func shutdownPeer(t *testing.T) (*localrpc.Peer, func()) {
	t.Helper()
	left, right := net.Pipe()
	peer := localrpc.New(context.Background(), left, nil)
	t.Cleanup(peer.Close)
	t.Cleanup(func() { right.Close() })
	return peer, func() {
		right.Close()
		select {
		case <-peer.Done():
		case <-time.After(5 * time.Second):
			t.Fatal("peer EOF was not observed")
		}
	}
}

func TestShutdownEOFAndSuccessfulJoinAreSymmetric(t *testing.T) {
	for _, order := range []string{"eof-before-join", "join-before-eof", "eof-before-handler"} {
		t.Run(order, func(t *testing.T) {
			peer, disconnect := shutdownPeer(t)
			ctx, stop := context.WithCancel(context.Background())
			defer stop()
			server := &ownerServer{stop: stop}
			if order == "eof-before-handler" {
				disconnect()
				server.disconnected(peer)
			}
			attempt := server.shutdownStarted(peer)
			if order == "eof-before-join" {
				disconnect()
				server.disconnected(peer)
			}
			select {
			case <-ctx.Done():
				t.Fatal("EOF stopped owner before the real shutdown joined")
			default:
			}
			server.shutdownFinished(peer, attempt, true)
			if order == "join-before-eof" {
				select {
				case <-ctx.Done():
					t.Fatal("owner exited before its acknowledgement connection closed")
				default:
				}
				disconnect()
				server.disconnected(peer)
			}
			select {
			case <-ctx.Done():
			default:
				t.Fatal("successful shutdown lost the earlier EOF and stranded owner lease")
			}
		})
	}
}

func TestFailedShutdownAndOrdinaryEOFNeverStopOwner(t *testing.T) {
	peer, disconnect := shutdownPeer(t)
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	server := &ownerServer{stop: stop}
	disconnect()
	server.disconnected(peer)
	select {
	case <-ctx.Done():
		t.Fatal("ordinary client EOF shut down the runtime owner")
	default:
	}
	attempt := server.shutdownStarted(peer)
	server.shutdownFinished(peer, attempt, false)
	select {
	case <-ctx.Done():
		t.Fatal("failed child shutdown was reported as owner termination")
	default:
	}
	if len(server.shutdowns) != 0 {
		t.Fatal("failed shutdown retained unbounded disconnected-peer history")
	}
}
