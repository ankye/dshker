package localrpc

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// OwnerLock serializes the desktop-owned and headless-owned cores for one
// explicitly named state directory. The lock is an OS advisory file lock, not
// a PID file: a crashed owner releases it without guessing whether a PID was
// reused. No stores, device keys, listener, or peer host may open before it.
type OwnerLock struct {
	file *os.File
	once sync.Once
}

const ownerLockFileName = "owner.lock"

// AcquireOwnerLock obtains one machine host ownership lease. A desktop core
// uses wait=false and refuses a competing owner. A boot-time serve uses
// wait=true: launchd may start it while the desktop is still open, but the
// second process cannot construct another host until the desktop exits.
func AcquireOwnerLock(ctx context.Context, state string, wait bool) (*OwnerLock, error) {
	if !filepath.IsAbs(state) {
		return nil, errors.New("p2p.invalid_arguments")
	}
	if err := validateOwnerDirectory(state); err != nil {
		return nil, err
	}
	path := filepath.Join(state, ownerLockFileName)
	if info, err := os.Lstat(path); err == nil && (!info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0) {
		return nil, errors.New("p2p.insecure_socket")
	} else if err != nil && !os.IsNotExist(err) {
		return nil, errors.New("p2p.insecure_socket")
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, errors.New("p2p.insecure_socket")
	}
	lock := &OwnerLock{file: file}
	for {
		if ctx.Err() != nil {
			file.Close()
			return nil, errors.New("p2p.request_cancelled")
		}
		busy, err := tryOwnerLock(file)
		if err != nil {
			file.Close()
			return nil, errors.New("p2p.owner_lock_failed")
		}
		if !busy {
			if ctx.Err() != nil {
				lock.Release()
				return nil, errors.New("p2p.request_cancelled")
			}
			return lock, nil
		}
		if !wait {
			file.Close()
			return nil, errors.New("p2p.owner_busy")
		}
		select {
		case <-ctx.Done():
			file.Close()
			return nil, errors.New("p2p.request_cancelled")
		case <-time.After(200 * time.Millisecond):
		}
	}
}

// Release relinquishes ownership exactly once. The lock file stays in the
// private state directory; unlinking it would let two processes lock distinct
// inodes under the same path during a handoff.
func (lock *OwnerLock) Release() error {
	if lock == nil {
		return nil
	}
	var released error
	lock.once.Do(func() {
		if err := unlockOwner(lock.file); err != nil {
			released = errors.New("p2p.owner_lock_failed")
		}
		if err := lock.file.Close(); err != nil {
			released = errors.New("p2p.owner_lock_failed")
		}
	})
	return released
}
