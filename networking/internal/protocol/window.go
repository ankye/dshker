package protocol

import "errors"

// Window tracks one direction of a reliable byte stream. Its owner serializes
// access. Credit is returned only for bytes actually consumed, never on receipt.
// The fixed reservation lets 64 streams remain within the 8 MiB receive budget.
const StreamWindowBytes = MaxQueueBytes / MaxStreams

type Window struct {
	available uint32
	pending   uint32
	finished  bool
}

func NewWindow(credit uint32) (*Window, error) {
	if credit == 0 || credit > StreamWindowBytes {
		return nil, errors.New("p2p.invalid_credit")
	}
	return &Window{available: credit}, nil
}

// Take admits exactly one data frame; rejection leaves all counters unchanged.
func (window *Window) Take(size int) error {
	if window.finished {
		return errors.New("p2p.stream_finished")
	}
	if size <= 0 || size > MaxDataBytes {
		return errors.New("p2p.protocol_limit")
	}
	if uint32(size) > window.available {
		return errors.New("p2p.credit_exhausted")
	}
	window.available -= uint32(size)
	window.pending += uint32(size)
	return nil
}

// Return accounts for read bytes (receive side) or WINDOW_UPDATE (send side).
// A peer cannot inflate its initial reservation, including after FIN.
func (window *Window) Return(size uint32) error {
	if size == 0 || size > window.pending {
		return errors.New("p2p.invalid_credit")
	}
	window.pending -= size
	window.available += size
	return nil
}

// Finish closes only this direction. Pending bytes remain readable; the reverse
// direction has an independent Window and is not affected by this FIN.
func (window *Window) Finish() error {
	if window.finished {
		return errors.New("p2p.stream_finished")
	}
	window.finished = true
	return nil
}

func (window *Window) Available() uint32 { return window.available }
func (window *Window) Pending() uint32   { return window.pending }
func (window *Window) Drained() bool     { return window.finished && window.pending == 0 }
