package helper

import "testing"

func TestPairStageDoesNotReviveRetiredOwnerFromCachedReady(t *testing.T) {
	f, first, _ := multiNetworkFixture(t)
	f.account.mu.Lock()
	f.account.stages = map[string]string{first.Target.DeviceID: "ready"}
	f.account.mu.Unlock()
	if err := f.account.manager.RetireScopedPin(first.Target.DeviceID, first.Pair.NetworkID); err != nil {
		t.Fatal(err)
	}
	if stage := f.host.pairStage(f.account.identity.ServiceID, first.Target.DeviceID); stage.Stage == "ready" {
		t.Fatal("retired Manager ownership fell back to cached ready", stage)
	}
	if _, err := f.account.manager.CurrentState(first.Target.DeviceID); err == nil {
		t.Fatal("retired owner still supplied a current state")
	}
}
