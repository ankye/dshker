package protocol

import "errors"

const MaxDataBytes = 16 * 1024
const MaxStreams = 64
const MaxQueueBytes = 8 * 1024 * 1024

// Frame is strictly decoded before stateful stream admission. Payload is JSON base64.
type Frame struct {
	Version           int    `json:"version"`
	Type              string `json:"type"`
	AttemptID         string `json:"attemptId"`
	Generation        uint64 `json:"generation"`
	RuntimeGeneration uint64 `json:"runtimeGeneration"`
	StreamID          uint32 `json:"streamId"`
	Credit            uint32 `json:"credit"`
	Data              []byte `json:"data"`
}

func (frame Frame) Validate(attempt string, generation, runtime uint64) error {
	if frame.Version != Version || !ValidID(frame.AttemptID) || frame.AttemptID != attempt ||
		generation == 0 || runtime == 0 || frame.Generation != generation || frame.RuntimeGeneration != runtime || frame.StreamID == 0 {
		return errors.New("p2p.frame_scope_mismatch")
	}
	if frame.Data == nil || len(frame.Data) > MaxDataBytes || frame.Credit > MaxQueueBytes {
		return errors.New("p2p.protocol_limit")
	}
	switch frame.Type {
	case "OPEN", "WINDOW_UPDATE":
		if frame.Credit == 0 || len(frame.Data) != 0 {
			return errors.New("p2p.invalid_frame")
		}
	case "DATA":
		if len(frame.Data) == 0 || frame.Credit != 0 {
			return errors.New("p2p.invalid_frame")
		}
	case "FIN", "RESET":
		if len(frame.Data) != 0 || frame.Credit != 0 {
			return errors.New("p2p.invalid_frame")
		}
	default:
		return errors.New("p2p.protocol_mismatch")
	}
	return nil
}
