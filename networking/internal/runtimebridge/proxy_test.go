package runtimebridge

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/peer"
	"github.com/ankye/dshker/networking/internal/protocol"
	"github.com/coder/websocket"
	"github.com/pion/stun/v3"
)

// The HTTP authority is a test-only protocol oracle, not a production runtime
// substitute. Transport between both gateways is actual Pion UDP/DTLS/SCTP.
func directMuxes(t *testing.T) (context.Context, *peer.Mux, *peer.Mux) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	t.Cleanup(cancel)
	udp, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { udp.Close() })
	go func() {
		buffer := make([]byte, 1024)
		for {
			n, address, err := udp.ReadFromUDP(buffer)
			if err != nil {
				return
			}
			request := &stun.Message{Raw: append([]byte(nil), buffer[:n]...)}
			if request.Decode() != nil || request.Type != stun.BindingRequest {
				continue
			}
			response, err := stun.Build(stun.NewTransactionIDSetter(request.TransactionID), stun.BindingSuccess, &stun.XORMappedAddress{IP: address.IP, Port: address.Port})
			if err == nil {
				udp.WriteToUDP(response.Raw, address)
			}
		}
	}()
	serviceKey, servicePrivate, _ := ed25519.GenerateKey(rand.Reader)
	aKey, aPrivate, _ := ed25519.GenerateKey(rand.Reader)
	bKey, bPrivate, _ := ed25519.GenerateKey(rand.Reader)
	scope := protocol.SignalScope{AttemptID: protocol.NewID(), PairID: protocol.NewID(), FromDeviceID: protocol.NewID(), ToDeviceID: protocol.NewID(), Generation: 1, NextSequence: 1}
	lease := protocol.Lease{Version: 1, ServiceID: protocol.KeyID(serviceKey), UserID: protocol.NewID(), NetworkID: protocol.NewID(), PairID: scope.PairID, AttemptID: scope.AttemptID, FromDeviceID: scope.FromDeviceID, ToDeviceID: scope.ToDeviceID, Generation: 1, Revision: 1, ExpiresAt: time.Now().Add(time.Minute).Unix(), Permission: "dsh-session"}
	lease.Signature = base64.RawURLEncoding.EncodeToString(ed25519.Sign(servicePrivate, lease.SigningBytes()))
	options := peer.TransportOptions{UserID: lease.UserID, NetworkID: lease.NetworkID, STUNAddress: udp.LocalAddr().String(), LocalDeviceID: scope.FromDeviceID, PeerDeviceID: scope.ToDeviceID, PrivateKey: aPrivate, PeerKey: bKey, ServiceKey: serviceKey, Scope: scope, Revision: 1, Lease: lease}
	a, err := peer.NewTransport(ctx, options)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { a.Close() })
	options.LocalDeviceID, options.PeerDeviceID, options.PrivateKey, options.PeerKey = scope.ToDeviceID, scope.FromDeviceID, bPrivate, aKey
	b, err := peer.NewTransport(ctx, options)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { b.Close() })
	offer, err := a.Offer(ctx)
	if err != nil {
		t.Fatal(err)
	}
	answer, err := b.AcceptOffer(ctx, offer)
	if err != nil {
		t.Fatal(err)
	}
	if err := a.AcceptAnswer(answer); err != nil {
		t.Fatal(err)
	}
	if err := a.WaitReady(ctx); err != nil {
		t.Fatal(err)
	}
	if err := b.WaitReady(ctx); err != nil {
		t.Fatal(err)
	}
	muxScope := peer.StreamScope{AttemptID: scope.AttemptID, Generation: 1, RuntimeGeneration: 7, Initiator: true}
	left, err := peer.NewMux(a, muxScope)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { left.Close() })
	muxScope.Initiator = false
	right, err := peer.NewMux(b, muxScope)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { right.Close() })
	return ctx, left, right
}

func TestDirectRuntimeHTTPWebSocketAndIsolation(t *testing.T) {
	ctx, left, right := directMuxes(t)
	var authority string
	oracle := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host != authority {
			http.Error(w, "wrong runtime", 403)
			return
		}
		if r.URL.Query().Get("token") == "isolated-test-token" {
			http.SetCookie(w, &http.Cookie{Name: "dsh-session", Value: "isolated-test-cookie", Path: "/", HttpOnly: true})
			http.Redirect(w, r, "/", http.StatusSeeOther)
			return
		}
		cookie, err := r.Cookie("dsh-session")
		if err != nil || cookie.Value != "isolated-test-cookie" {
			http.Error(w, "unauthorized", 401)
			return
		}
		if r.URL.Path == "/api/remote.mux" {
			connection, err := websocket.Accept(w, r, nil)
			if err != nil {
				return
			}
			defer connection.CloseNow()
			kind, data, err := connection.Read(ctx)
			if err != nil {
				return
			}
			connection.Write(ctx, kind, data)
			connection.Close(websocket.StatusNormalClosure, "done")
			return
		}
		if r.URL.Path == "/external" {
			http.Redirect(w, r, "https://example.invalid/", 302)
			return
		}
		if r.URL.Path == "/absolute" {
			http.Redirect(w, r, "http://"+authority+"/result?x=1", 302)
			return
		}
		io.WriteString(w, r.URL.RequestURI())
	}))
	defer oracle.Close()
	parsed, _ := url.Parse(oracle.URL)
	authority = parsed.Host
	binding := Binding{Generation: 7, URL: oracle.URL + "/?token=isolated-test-token"}
	target, err := ServeTarget(ctx, right, binding)
	if err != nil {
		t.Fatal(err)
	}
	defer target.Close()
	browser, err := OpenBrowser(ctx, left, binding)
	if err != nil {
		t.Fatal(err)
	}
	defer browser.Close()
	local, _ := url.Parse(browser.URL)
	jar, _ := cookiejar.New(nil)
	client := &http.Client{Jar: jar, Timeout: 5 * time.Second}
	response, err := client.Get(browser.URL)
	if err != nil {
		t.Fatal(err)
	}
	data, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if response.StatusCode != 200 || string(data) != "/" || len(jar.Cookies(local)) != 1 {
		t.Fatal("authentication/redirect readback failed", response.StatusCode, string(data))
	}
	for _, path := range []string{"/a%20b?q=%E4%B8%AD&n=2", "/absolute"} {
		response, err = client.Get(local.Scheme + "://" + local.Host + path)
		if err != nil {
			t.Fatal(err)
		}
		data, _ = io.ReadAll(response.Body)
		response.Body.Close()
		expected := path
		if path == "/absolute" {
			expected = "/result?x=1"
		}
		if string(data) != expected || response.Request.URL.Host != local.Host {
			t.Fatal("path/query/redirect substituted", string(data))
		}
	}
	response, err = client.Get(local.Scheme + "://" + local.Host + "/external")
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 502 {
		t.Fatal("external redirect accepted")
	}
	headers := http.Header{"Origin": []string{local.Scheme + "://" + local.Host}}
	ws, _, err := websocket.Dial(ctx, "ws://"+local.Host+"/api/remote.mux", &websocket.DialOptions{HTTPClient: client, HTTPHeader: headers})
	if err != nil {
		t.Fatal(err)
	}
	defer ws.CloseNow()
	content := "actual direct websocket payload"
	if err = ws.Write(ctx, websocket.MessageText, []byte(content)); err != nil {
		t.Fatal(err)
	}
	_, data, err = ws.Read(ctx)
	if err != nil || string(data) != content {
		t.Fatal("WS readback mismatch", err)
	}
	ws.Close(websocket.StatusNormalClosure, "done")
	for _, attack := range []string{"origin", "host", "connect", "upgrade"} {
		r, _ := http.NewRequestWithContext(ctx, "GET", local.Scheme+"://"+local.Host+"/", nil)
		switch attack {
		case "origin":
			r.Header.Set("Origin", "https://foreign.invalid")
		case "host":
			r.Host = "foreign.invalid"
		case "connect":
			r.Method = "CONNECT"
		case "upgrade":
			r.Header.Set("Upgrade", "websocket")
			r.Header.Set("Connection", "Upgrade")
		}
		response, err = client.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != 403 {
			t.Fatal("attack admitted", attack, response.StatusCode)
		}
	}
	browser.Close()
	if _, err = client.Get(browser.URL); err == nil {
		t.Fatal("closed browser remained reachable")
	}
	response, err = http.Get(oracle.URL)
	if err != nil {
		t.Fatal("browser close stopped target runtime", err)
	}
	response.Body.Close()
}

func TestBindingRequiresExactLoopbackRuntime(t *testing.T) {
	for _, raw := range []string{"http://example.com:1234/?token=t", "http://127.0.0.1/?token=t", "http://127.0.0.1:1234/", "http://user@127.0.0.1:1234/?token=t", "http://127.0.0.1:1234/?token=t&token=u", "http://127.0.0.1:1234/?token=t&other=x", "https://127.0.0.1:1234/?token=t"} {
		if _, err := (Binding{Generation: 1, URL: raw}).Endpoint(); err == nil {
			t.Fatal("invalid runtime accepted", strings.Split(raw, "?")[0])
		}
	}
}
