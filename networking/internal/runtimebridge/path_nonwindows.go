//go:build !windows

package runtimebridge

import "path/filepath"

func resolvePath(path string) (string, error) {
	return filepath.EvalSymlinks(path)
}
