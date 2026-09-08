//go:build windows

package runtimebridge

import (
	"errors"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

// resolvePath follows Windows reparse points, including directory junctions.
// filepath.EvalSymlinks does not resolve junction targets on all supported Go
// versions, so containment checks use the kernel's final handle path instead.
func resolvePath(path string) (string, error) {
	name, err := windows.UTF16PtrFromString(filepath.Clean(path))
	if err != nil {
		return "", err
	}
	handle, err := windows.CreateFile(
		name,
		windows.FILE_READ_ATTRIBUTES,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil,
		windows.OPEN_EXISTING,
		windows.FILE_FLAG_BACKUP_SEMANTICS,
		0,
	)
	if err != nil {
		return "", err
	}
	defer windows.CloseHandle(handle)

	buffer := make([]uint16, windows.MAX_LONG_PATH)
	n, err := windows.GetFinalPathNameByHandle(handle, &buffer[0], uint32(len(buffer)), 0)
	if err != nil {
		return "", err
	}
	if n >= uint32(len(buffer)-1) {
		return "", errors.New("resolved path exceeds Windows maximum path length")
	}
	final := windows.UTF16ToString(buffer[:n])
	if strings.HasPrefix(final, `\\?\UNC\`) {
		final = `\\` + strings.TrimPrefix(final, `\\?\UNC\`)
	} else {
		final = strings.TrimPrefix(final, `\\?\`)
	}
	return filepath.Clean(final), nil
}
