package secret

import (
	"errors"
	"strings"
	"testing"
)

func TestSecretNamespacePreservesLegacyAndRejectsUnsafeIdentity(t *testing.T) {
	for namespace, expected := range map[string]string{
		"": legacyService, "profile-0123": "dshkerd.profile-0123",
		"0": "dshkerd.0", strings.Repeat("a", 128): "dshkerd." + strings.Repeat("a", 128),
	} {
		service, err := serviceForNamespace(namespace)
		if err != nil || service != expected {
			t.Fatalf("namespace %q changed provider identity: %q, %v", namespace, service, err)
		}
	}
	for _, namespace := range []string{
		" ", "profile/test", "profile\\test", "../formal", "-profile", ".profile",
		"Profile", "profile\nformal", "profile\x00formal", "测试", strings.Repeat("a", 129),
	} {
		if service, err := serviceForNamespace(namespace); service != "" || !errors.Is(err, ErrNamespace) {
			t.Fatalf("unsafe namespace %q admitted: %q, %v", namespace, service, err)
		}
		// Validation precedes platform discovery or any credential-store access.
		if store, err := OpenNamespace("", namespace); store != nil || !errors.Is(err, ErrNamespace) {
			t.Fatalf("invalid namespace reached a provider: %q, %v", namespace, err)
		}
	}
}

func TestSecretServiceProfileIdentityAppliesToEveryOperation(t *testing.T) {
	for _, service := range []string{legacyService, "dshkerd.profile-a", "dshkerd.profile-b"} {
		tool := &recorder{}
		store := secretServiceStore{run: tool.run, service: service}
		if err := store.Set("machine.device-key", []byte("private-value")); err != nil {
			t.Fatal(err)
		}
		if _, err := store.Get("machine.device-key"); err != nil {
			t.Fatal(err)
		}
		if err := store.Delete("machine.device-key"); err != nil {
			t.Fatal(err)
		}
		for _, arguments := range tool.calls {
			last := arguments[len(arguments)-4:]
			if strings.Join(last, " ") != "service "+service+" key machine.device-key" {
				t.Fatalf("operation escaped profile identity: %v", arguments)
			}
			if strings.Contains(strings.Join(arguments, " "), "private-value") {
				t.Fatal("secret entered process arguments")
			}
		}
	}
}
