package protocol

import "testing"

func TestWindowSlowReaderAndExactCredit(t *testing.T) {
	window, err := NewWindow(StreamWindowBytes)
	if err != nil {
		t.Fatal(err)
	}
	for range StreamWindowBytes / MaxDataBytes {
		if err := window.Take(MaxDataBytes); err != nil {
			t.Fatal(err)
		}
	}
	if err := window.Take(1); err == nil || window.Available() != 0 || window.Pending() != StreamWindowBytes {
		t.Fatal("slow reader did not stop at its exact reservation")
	}
	if err := window.Return(7); err != nil {
		t.Fatal(err)
	}
	if err := window.Take(8); err == nil || window.Available() != 7 {
		t.Fatal("write exceeded actual returned credit")
	}
	if err := window.Take(7); err != nil || window.Pending() != StreamWindowBytes {
		t.Fatal("exact credit did not resume sender", err)
	}
}

func TestWindowRejectsInflationWithoutMutation(t *testing.T) {
	for _, credit := range []uint32{0, StreamWindowBytes + 1, ^uint32(0)} {
		if _, err := NewWindow(credit); err == nil {
			t.Fatalf("accepted initial credit %d", credit)
		}
	}
	window, err := NewWindow(StreamWindowBytes)
	if err != nil {
		t.Fatal(err)
	}
	for _, size := range []int{-1, 0, MaxDataBytes + 1} {
		if err := window.Take(size); err == nil || window.Pending() != 0 || window.Available() != StreamWindowBytes {
			t.Fatalf("invalid frame %d mutated credit", size)
		}
	}
	if err := window.Take(9); err != nil {
		t.Fatal(err)
	}
	for _, size := range []uint32{0, 10, ^uint32(0)} {
		if err := window.Return(size); err == nil || window.Pending() != 9 || window.Available() != StreamWindowBytes-9 {
			t.Fatalf("inflation %d mutated credit", size)
		}
	}
	if err := window.Return(9); err != nil || window.Available() != StreamWindowBytes {
		t.Fatal("valid recovery failed", err)
	}
	if err := window.Return(9); err == nil {
		t.Fatal("duplicate update inflated credit")
	}
}

func TestWindowHalfCloseDrainsWithoutClosingReverseDirection(t *testing.T) {
	forward, err := NewWindow(32)
	if err != nil {
		t.Fatal(err)
	}
	reverse, err := NewWindow(32)
	if err != nil {
		t.Fatal(err)
	}
	if err := forward.Take(12); err != nil {
		t.Fatal(err)
	}
	if err := forward.Finish(); err != nil || forward.Drained() {
		t.Fatal("FIN discarded unread bytes", err)
	}
	if err := forward.Take(1); err == nil || forward.Pending() != 12 {
		t.Fatal("accepted DATA after FIN")
	}
	if err := reverse.Take(20); err != nil || reverse.Pending() != 20 {
		t.Fatal("FIN affected reverse direction", err)
	}
	if err := forward.Return(12); err != nil || !forward.Drained() {
		t.Fatal("could not consume bytes preceding FIN", err)
	}
	if err := forward.Finish(); err == nil {
		t.Fatal("accepted repeated FIN")
	}
}
