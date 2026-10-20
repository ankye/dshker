//go:build live && windows

package integration

import (
	"errors"
	"io"
	"os"

	"golang.org/x/sys/windows"
)

// Publication uses Rename, whose Windows handle requests DELETE access. Admit
// that immutable publisher on the first open, not after a sharing-error retry.
func recoveryPauseReadBytes(path string) ([]byte, error) {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	handle, err := windows.CreateFile(name, windows.GENERIC_READ,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	file := os.NewFile(uintptr(handle), path)
	if file == nil {
		return nil, errors.Join(os.ErrInvalid, windows.CloseHandle(handle))
	}
	data, readErr := io.ReadAll(file)
	return data, errors.Join(readErr, file.Close())
}
