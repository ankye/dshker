package helper

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/ankye/dshker/networking/internal/controlplane"
)

func TestEntryAdmissionRejectsUnknownMissingAndMalformedScope(t *testing.T) {
	host := New(context.Background())
	t.Cleanup(host.Close)
	host.accounts["aaaaaaaaaaaa"] = &account{identity: controlplane.Identity{ServiceID: "aaaaaaaaaaaa"}, host: host}
	for payload, want := range map[string]string{
		`{"serviceId":"aaaaaaaaaaaa","data":{"pairId":"bbbbbbbbbbbb","generation":7}}`:              "p2p.device_unregistered",
		`{"serviceId":"cccccccccccc","data":{"pairId":"bbbbbbbbbbbb","generation":7}}`:              "p2p.service_unconfigured",
		`{"serviceId":"bad","data":{"pairId":"bbbbbbbbbbbb","generation":7}}`:                       "p2p.invalid_request",
		`{"serviceId":"aaaaaaaaaaaa","data":{"pairId":"bbbbbbbbbbbb"}}`:                             "p2p.invalid_request",
		`{"serviceId":"aaaaaaaaaaaa","data":{"pairId":"bbbbbbbbbbbb","generation":0}}`:              "p2p.invalid_request",
		`{"serviceId":"aaaaaaaaaaaa","data":{"pairId":"bbbbbbbbbbbb","generation":7,"extra":true}}`: "p2p.invalid_request",
		`{"serviceId":"aaaaaaaaaaaa","data":{"pairId":"bbbbbbbbbbbb","generation":7},"extra":true}`: "p2p.invalid_request",
	} {
		if _, err := host.Handle(context.Background(), "peer.entry", json.RawMessage(payload)); err == nil || err.Error() != want {
			t.Errorf("entry admission = %v, want %s", err, want)
		}
	}
}

func TestForgetServiceCancelsAndRemovesItsOwner(t *testing.T) {
	host := New(context.Background())
	t.Cleanup(host.Close)
	ctx, cancel := context.WithCancel(host.ctx)
	host.accounts["aaaaaaaaaaaa"] = &account{host: host, cancel: cancel}
	host.ForgetService("aaaaaaaaaaaa")
	if ctx.Err() == nil || host.accounts["aaaaaaaaaaaa"] != nil {
		t.Fatal("service removal retained its account lifetime or owner")
	}
	if err := host.connectPair(context.Background(), "aaaaaaaaaaaa", "bbbbbbbbbbbb"); err == nil || err.Error() != "p2p.service_unconfigured" {
		t.Fatalf("forgotten service remained reconnectable: %v", err)
	}
}
