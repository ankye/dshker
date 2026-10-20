package runtimebridge

import (
	"context"
	"errors"
	"fmt"
	"os"

	"github.com/ankye/dshker/networking/internal/peer"
	"github.com/ankye/dshker/networking/internal/protocol"
)

// WorkbenchOwners separates explicit cold-start authority from read-only resume.
// A missing Resume callback is a refusal, never permission to invoke Open.
type WorkbenchOwners struct {
	Open   RuntimeOwner
	Resume RuntimeOwner
}

func negotiateWorkbench(ctx context.Context, transport *peer.Transport, lease protocol.Lease, initiator, requested, resume bool, owners WorkbenchOwners) (Binding, string, error) {
	capabilities := protocol.PeerCapabilitiesFor(requested && !resume)
	operation := "runtime.connect"
	if resume {
		capabilities = protocol.PeerResumeCapabilities()
		operation = "runtime.resume"
	}
	header := hello{Version: 1, Type: "runtime.connect", AttemptID: lease.AttemptID, Generation: lease.Generation, Capabilities: capabilities}
	if initiator {
		if err := sendHello(transport, header); err != nil {
			return Binding{}, "", err
		}
		response, err := readHello(ctx, transport, header)
		if err != nil {
			return Binding{}, "", err
		}
		if response.Type != "runtime.result" || !protocol.ValidCapabilities(response.Capabilities) {
			return Binding{}, "", errors.New("p2p.protocol_mismatch")
		}
		if resume && !protocol.HasCapability(response.Capabilities, protocol.CapabilityWorkbenchResumeSupported) {
			// A legacy peer saw no workbench.request, so it cannot have started
			// DSH. Do not reinterpret its answer or downgrade to explicit start.
			response.Error = "p2p.protocol_mismatch"
		}
		if response.Error != "" {
			code := workbenchRefusal(errors.New(response.Error))
			fmt.Fprintf(os.Stderr, "%s peer has no workbench: %s (connection kept)\n", operation, code)
			if !requested {
				code = ""
			}
			return Binding{}, code, nil
		}
		return Binding{Generation: response.RuntimeGeneration, URL: response.URL}, "", nil
	}
	incoming, err := readHello(ctx, transport, header)
	if err != nil {
		return Binding{}, "", err
	}
	if incoming.Type != "runtime.connect" || incoming.RuntimeGeneration != 0 || incoming.URL != "" || incoming.Error != "" || !protocol.ValidCapabilities(incoming.Capabilities) {
		return Binding{}, "", errors.New("p2p.protocol_mismatch")
	}
	openRequested := protocol.HasCapability(incoming.Capabilities, protocol.CapabilityWorkbenchRequest)
	resumeRequested := protocol.HasCapability(incoming.Capabilities, protocol.CapabilityWorkbenchResume)
	if openRequested && resumeRequested {
		return Binding{}, "", errors.New("p2p.protocol_mismatch")
	}
	owner := owners.Open
	if resumeRequested {
		operation, owner = "runtime.resume", owners.Resume
	}
	header.Type, header.Capabilities = "runtime.result", protocol.PeerCapabilities()
	var binding Binding
	if !openRequested && !resumeRequested {
		header.Error = "p2p.runtime_unavailable"
		fmt.Fprintf(os.Stderr, "runtime.connect transport-only request peer=%s (connection kept, no workbench)\n", peerDeviceID(lease, false))
	} else if owner == nil {
		err = errors.New("p2p.runtime_unavailable")
	} else {
		binding, err = owner(ctx, peerDeviceID(lease, false))
	}
	if err != nil {
		header.Error = workbenchRefusal(err)
		fmt.Fprintf(os.Stderr, "%s owner refused peer=%s: %v (connection kept, no workbench)\n", operation, peerDeviceID(lease, false), err)
		binding = Binding{}
	} else if header.Error == "" {
		if _, invalid := binding.Endpoint(); invalid != nil {
			header.Error, binding = "p2p.runtime_invalid", Binding{}
		} else {
			header.RuntimeGeneration, header.URL = binding.Generation, binding.URL
		}
	}
	if err := sendHello(transport, header); err != nil {
		return Binding{}, "", err
	}
	return binding, header.Error, nil
}

func workbenchRefusal(err error) string {
	if code, ok := protocol.Refusal(err); ok {
		return code
	}
	return "p2p.runtime_unavailable"
}
