//go:build windows

package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

type consoleReceipt struct {
	Kind                string   `json:"kind"`
	PID                 int      `json:"pid"`
	ParentPID           int      `json:"parentPid"`
	ConsoleWindow       uintptr  `json:"consoleWindow"`
	ConsoleProcessCount uint32   `json:"consoleProcessCount"`
	ConsoleProcessIDs   []uint32 `json:"consoleProcessIds"`
	ConsoleError        uint32   `json:"consoleError"`
}

func main() {
	if len(os.Args) != 2 {
		fail("one probe mode is required")
	}
	mode := os.Args[1]
	if mode == "fail" {
		fmt.Fprintln(os.Stderr, "console-probe requested failure")
		os.Exit(7)
	}
	if mode != "once" && mode != "tree" && mode != "leaf" {
		fail("unknown probe mode")
	}
	if mode == "tree" {
		executable, err := os.Executable()
		if err != nil {
			fail(err.Error())
		}
		child := exec.Command(executable, "leaf")
		// The probe's own descendant also stays noninteractive; only the tested
		// supervisor, rather than this helper, supplies the root's attributes.
		child.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
		child.Stdout, child.Stderr = os.Stdout, os.Stderr
		if err := child.Start(); err != nil {
			fail(err.Error())
		}
		go func() { _ = child.Wait() }()
	}
	if err := report(mode); err != nil {
		fail(err.Error())
	}
	if mode != "once" {
		<-time.NewTimer(30 * time.Minute).C
	}
}

func report(mode string) error {
	kernel := windows.NewLazySystemDLL("kernel32.dll")
	getWindow := kernel.NewProc("GetConsoleWindow")
	getProcesses := kernel.NewProc("GetConsoleProcessList")
	if err := getWindow.Find(); err != nil {
		return err
	}
	if err := getProcesses.Find(); err != nil {
		return err
	}
	handle, _, _ := getWindow.Call()
	processes := make([]uint32, 8)
	count, _, processErr := getProcesses.Call(uintptr(unsafe.Pointer(&processes[0])), uintptr(len(processes)))
	var errorCode uint32
	if count == 0 {
		if errno, ok := processErr.(syscall.Errno); ok {
			errorCode = uint32(errno)
		}
	}
	receipt := consoleReceipt{Kind: mode, PID: os.Getpid(), ParentPID: os.Getppid(), ConsoleWindow: handle, ConsoleProcessCount: uint32(count), ConsoleProcessIDs: processes[:min(int(count), len(processes))], ConsoleError: errorCode}
	if err := json.NewEncoder(os.Stdout).Encode(receipt); err != nil {
		return err
	}
	_, err := fmt.Fprintf(os.Stderr, "console-probe stderr pid=%d kind=%s\n", receipt.PID, mode)
	return err
}

func fail(message string) {
	fmt.Fprintln(os.Stderr, message)
	os.Exit(2)
}
