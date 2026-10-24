//go:build !windows

package runtimeowner

import (
	"context"
	"errors"
	"syscall"
)

const containmentKind = "unix-process-groups-v1"

type processContainment struct{}

func newProcessContainment(ownerRecord) (*processContainment, error) {
	return &processContainment{}, nil
}
func (*processContainment) close(bool)                            {}
func (*processContainment) stopAllChildren(context.Context) error { return nil }
func (*processContainment) containedExit() bool                   { return false }

func (*processContainment) allChildrenGone(children []processIdentity) (bool, error) {
	for _, child := range children {
		if child.PID <= 0 || uint64(child.PID) > maxRecordedPID {
			return false, ErrOwnerUnavailable
		}
		err := syscall.Kill(-child.PID, 0)
		if errors.Is(err, syscall.ESRCH) {
			continue
		}
		if err != nil {
			return false, ErrOwnerUnavailable
		}
		return false, nil // A live or unreaped member still owns the original PGID.
	}
	return true, nil
}

func recoveryContainmentGone(journal recoveryJournal) (bool, error) {
	if journal.Containment != containmentKind {
		return false, ErrOwnerRecordInvalid
	}
	// A crashed Unix owner's active descendants are not kernel-contained by the
	// owner process lifetime. Only explicit idle proof or a different boot admits.
	return journal.Phase == "idle", nil
}
