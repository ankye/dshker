package localrpc

import (
	"errors"
	"net"
	"strings"

	"github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
)

func Listen(path string) (net.Listener, error) {
	const prefix = `\\.\pipe\dshker-peer-`
	if !strings.HasPrefix(path, prefix) || len(path) != len(prefix)+32 {
		return nil, errors.New("p2p.invalid_socket")
	}
	for _, c := range path[len(prefix):] {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return nil, errors.New("p2p.invalid_socket")
		}
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		return nil, errors.New("p2p.helper_user_unavailable")
	}
	return winio.ListenPipe(path, &winio.PipeConfig{SecurityDescriptor: "D:P(A;;GA;;;" + user.User.Sid.String() + ")", InputBufferSize: 65536, OutputBufferSize: 65536})
}
