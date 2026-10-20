package protocol

import "testing"

func TestResumeCapabilitiesNeverGrantColdStart(t *testing.T) {
	resume := PeerResumeCapabilities()
	if !HasCapability(resume, CapabilityWorkbenchResume) || !HasCapability(resume, CapabilityWorkbenchResumeSupported) || HasCapability(resume, CapabilityWorkbenchRequest) {
		t.Fatalf("resume capabilities grant cold start or omit resume support: %v", resume)
	}
	manual := PeerCapabilitiesFor(true)
	if !HasCapability(manual, CapabilityWorkbenchRequest) || HasCapability(manual, CapabilityWorkbenchResume) {
		t.Fatalf("manual capabilities lost explicit-start intent: %v", manual)
	}
	background := PeerCapabilitiesFor(false)
	if HasCapability(background, CapabilityWorkbenchRequest) || HasCapability(background, CapabilityWorkbenchResume) {
		t.Fatalf("background capabilities request a workbench: %v", background)
	}
	resume[0] = "mutated"
	if !HasCapability(PeerResumeCapabilities(), CapabilityOptionalWorkbench) {
		t.Fatal("caller mutated the advertised capability authority")
	}
}
