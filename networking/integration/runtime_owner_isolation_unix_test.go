//go:build !windows

package integration

import "os/exec"

func isolationHideCommand(*exec.Cmd) {}
