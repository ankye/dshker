//go:build live && !windows

package integration

import "os"

func recoveryPauseReadBytes(path string) ([]byte, error) {
	return os.ReadFile(path)
}
