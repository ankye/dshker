//go:build windows

package harnessruntime

// fakeChildCommand is a stand-in DSH Web process: it echoes pnpm's script line,
// announces the loopback URL DSH prints, and then stays alive until it is
// stopped. `ping` is the portable way to wait inside cmd.exe.
func fakeChildCommand(base string) Command {
	return Command{
		Executable: "cmd",
		Arguments:  []string{"/c", "echo $ dsh web --no-open 1>&2 & echo dsh web: http://127.0.0.1:3088/?token=abc & ping -n 30 127.0.0.1 > nul"},
		Directory:  base,
	}
}
