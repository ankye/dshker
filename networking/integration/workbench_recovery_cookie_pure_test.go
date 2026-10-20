//go:build live

package integration

import (
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestRecoveryCookieRejectsRotationWithinTheSameBrowserJar(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.SetCookie(w, &http.Cookie{Name: "dsh-auth-test", Value: "replacement-token", Path: "/"})
		_, _ = io.WriteString(w, "<html><script></script></html>")
	}))
	defer server.Close()
	base, err := url.Parse(server.URL)
	must(t, err)
	jar, err := cookiejar.New(nil)
	must(t, err)
	jar.SetCookies(base, []*http.Cookie{{Name: "dsh-auth-test", Value: "original-token", Path: "/"}})
	browser := &recoveryBrowser{base: base, client: &http.Client{Jar: jar}}
	browser.originalCookie = browser.cookieDigest(t)
	if err := browser.originalCookieError(); err != nil {
		t.Fatal("original cookie was refused", err)
	}
	response, err := browser.client.Get(server.URL)
	must(t, err)
	_, err = io.Copy(io.Discard, response.Body)
	response.Body.Close()
	must(t, err)
	if browser.client.Jar != jar || response.StatusCode != http.StatusOK {
		t.Fatal("counterexample did not retain the same successful browser and jar")
	}
	if err := browser.originalCookieError(); err == nil || !strings.Contains(err.Error(), "cookie_replaced") {
		t.Fatal("successful readback with the same jar hid replacement of the original cookie", err)
	}
	jar.SetCookies(base, []*http.Cookie{{Name: "dsh-auth-test", MaxAge: -1, Path: "/"}})
	if err := browser.originalCookieError(); err == nil || !strings.Contains(err.Error(), "cookie_lost") {
		t.Fatal("lost original cookie was admitted", err)
	}
}
