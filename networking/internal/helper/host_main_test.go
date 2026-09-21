package helper

import (
	"context"
	"encoding/json"
	"testing"
)

type callbackOwner struct{ name string }

func (owner callbackOwner) Call(context.Context, string, any) (json.RawMessage, error) {
	return json.Marshal(struct {
		Owner string `json:"owner"`
	}{owner.name})
}

func TestHostCallsCurrentMainAcrossAttachAndDetach(t *testing.T) {
	host := New(context.Background())
	if _, err := host.callMain(context.Background(), "peer.state", struct{}{}); err == nil || err.Error() != "p2p.helper_parent_unavailable" {
		t.Fatalf("missing callback owner = %v", err)
	}
	for _, owner := range []string{"headless", "desktop", "headless"} {
		host.BindMain(callbackOwner{name: owner})
		answer, err := host.callMain(context.Background(), "peer.state", struct{}{})
		if err != nil {
			t.Fatal(err)
		}
		if string(answer) != `{"owner":"`+owner+`"}` {
			t.Fatalf("callback went to %s: %s", owner, answer)
		}
	}
}
