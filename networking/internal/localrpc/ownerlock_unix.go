//go:build !windows

package localrpc

import (
	"errors"
	"os"
	"syscall"
)

func validateOwnerDirectory(path string) error {
	info, err := os.Lstat(path)
	if err != nil || !info.IsDir() || info.Mode().Perm() != 0o700 || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("p2p.insecure_socket_directory")
	}
	return nil
}

func tryOwnerLock(file *os.File) (bool, error) {
	err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
	if errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN) {
		return true, nil
	}
	return false, err
}

func unlockOwner(file *os.File) error {
	return syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
}
