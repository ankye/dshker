//go:build !windows

package runtimeowner

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

func ownerSocket(string) (string, string, error) {
	// One named, private Unix transport location, not a different transport or
	// fallback for long state paths. Its exact identity is in the private record.
	directory, err := os.MkdirTemp("/tmp", "dshker-runtime-")
	if err != nil {
		return "", "", ErrOwnerUnavailable
	}
	directory, err = filepath.EvalSymlinks(directory)
	if err != nil || checkPrivatePath(directory, true) != nil {
		return "", "", ErrOwnerRecordInvalid
	}
	return filepath.Join(directory, "peer.sock"), directory, nil
}

func validateOwnerEndpoint(record ownerRecord) error {
	return validateRecoveryEndpoint(record, false)
}

func validateRecoveryEndpoint(record ownerRecord, allowMissing bool) error {
	base, err := filepath.EvalSymlinks("/tmp")
	if err != nil || record.SocketDirectory == "" || filepath.Dir(record.SocketDirectory) != base || !strings.HasPrefix(filepath.Base(record.SocketDirectory), "dshker-runtime-") || record.Socket != filepath.Join(record.SocketDirectory, "peer.sock") {
		return ErrOwnerRecordInvalid
	}
	if err := checkPrivatePath(record.SocketDirectory, true); err != nil {
		if allowMissing && errors.Is(err, os.ErrNotExist) {
			return nil // A different kernel boot can remove the old /tmp endpoint.
		}
		return ErrOwnerRecordInvalid
	}
	return nil
}

func cleanupOwnerEndpoint(record ownerRecord) error {
	if err := validateOwnerEndpoint(record); err != nil {
		return err
	}
	if os.Remove(record.SocketDirectory) != nil {
		return ErrOwnerRecordInvalid
	}
	return nil
}

func detachedAttributes() *syscall.SysProcAttr { return &syscall.SysProcAttr{Setsid: true} }

func finalLink(info os.FileInfo) bool { return info.Mode()&os.ModeSymlink != 0 }

func createPrivateDirectory(path string) error { return os.Mkdir(path, 0o700) }

func openRecordFile(path string) (*os.File, error) {
	if err := checkPrivatePath(path, false); err != nil {
		return nil, err
	}
	return os.Open(path)
}

func publishRecordFile(source, destination string) error { return os.Rename(source, destination) }

func checkPrivatePath(path string, directory bool) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	mode := os.FileMode(0o600)
	if directory {
		mode = 0o700
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || int(stat.Uid) != os.Getuid() || info.Mode().Perm() != mode || info.Mode()&os.ModeSymlink != 0 || info.IsDir() != directory || (!directory && !info.Mode().IsRegular()) {
		return ErrOwnerRecordInvalid
	}
	return nil
}

func secureCreatedPath(path string, directory bool) error { return checkPrivatePath(path, directory) }

func syncRecordDirectory(path string) error {
	file, err := os.Open(path)
	if err != nil {
		return ErrOwnerRecordInvalid
	}
	defer file.Close()
	if file.Sync() != nil {
		return ErrOwnerRecordInvalid
	}
	return nil
}
