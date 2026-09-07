//go:build !windows

package localrpc

import (
	"errors"
	"net"
	"os"
	"path/filepath"
)

func Listen(path string) (net.Listener, error) {
	if !filepath.IsAbs(path) || filepath.Base(path) != "peer.sock" {
		return nil, errors.New("p2p.invalid_socket")
	}
	parent, err := os.Lstat(filepath.Dir(path))
	if err != nil || !parent.IsDir() || parent.Mode().Perm() != 0700 {
		return nil, errors.New("p2p.insecure_socket_directory")
	}
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		return nil, errors.New("p2p.helper_listen_failed")
	}
	if err = os.Chmod(path, 0600); err != nil {
		listener.Close()
		return nil, errors.New("p2p.insecure_socket")
	}
	return listener, nil
}
