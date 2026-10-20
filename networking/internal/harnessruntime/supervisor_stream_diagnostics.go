package harnessruntime

import (
	"errors"
	"fmt"
	"io"
	"os"
)

// A reader ending is not proof that its child exited. Record the exact launch's
// Wait receipt separately, without consulting ProcessState concurrently with
// Wait or copying arbitrary pipe errors into the product log.
func (active *record) observeStreamEnd(supervisor *Supervisor, stream string, err error) {
	reason := "read_failed"
	switch {
	case errors.Is(err, io.EOF):
		reason = "eof"
	case errors.Is(err, os.ErrClosed), errors.Is(err, io.ErrClosedPipe):
		reason = "closed"
	}
	wait := "pending"
	select {
	case <-active.exited:
		wait = "completed"
	default:
	}
	active.appendLauncherEvent(supervisor, fmt.Sprintf(
		"DSH Web stream ended (stream=%s reason=%s launch=%s pid=%d childWait=%s).",
		stream, reason, active.identity.LaunchID, active.pid(), wait,
	))
}
