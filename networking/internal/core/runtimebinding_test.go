package core

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/ankye/dshker/networking/internal/runtimebridge"
)

type bindingSource func(context.Context, string) (runtimebridge.Binding, error)

func (source bindingSource) Binding(ctx context.Context, subject string) (runtimebridge.Binding, error) {
	return source(ctx, subject)
}

// The authority owns generation. Recreating a core facade cannot reset it, and
// reading an existing child cannot manufacture another runtime generation.
func TestRuntimeBindingNamesOneGenerationPerChild(t *testing.T) {
	var absent *RuntimeBinding
	if _, err := absent.Binding(); !errors.Is(err, ErrRuntimeUnavailable) {
		t.Fatalf("nil binding = %v", err)
	}
	if _, err := (&RuntimeBinding{Subject: "subject_main"}).Binding(); !errors.Is(err, ErrRuntimeUnavailable) {
		t.Fatalf("no authority = %v", err)
	}
	current := runtimebridge.Binding{Generation: 41, URL: "http://127.0.0.1:3099/?token=sentinel"}
	source := bindingSource(func(ctx context.Context, subject string) (runtimebridge.Binding, error) {
		if subject != "subject_main" {
			t.Fatal("binding changed its exact subject")
		}
		if deadline, ok := ctx.Deadline(); !ok || time.Until(deadline) <= 0 || time.Until(deadline) > 5*time.Second {
			t.Fatal("headless binding read has no bounded authority context")
		}
		return current, nil
	})
	firstCore := &RuntimeBinding{Runtime: source, Subject: "subject_main"}
	first, err := firstCore.Binding()
	if err != nil || first != current {
		t.Fatal("core did not return the authority's exact binding")
	}
	secondCore := &RuntimeBinding{Runtime: source, Subject: "subject_main"}
	again, err := secondCore.Binding()
	if err != nil || again != first {
		t.Fatal("core restart reset the surviving authority generation")
	}
	current = runtimebridge.Binding{Generation: 57, URL: "http://127.0.0.1:3098/?token=other-sentinel"}
	for _, binding := range []*RuntimeBinding{firstCore, secondCore} {
		got, err := binding.Binding()
		if err != nil || got != current {
			t.Fatal("core replaced the current authority generation or address")
		}
	}
}

func TestRuntimeBindingPreservesAuthorityFailureAndCallerContext(t *testing.T) {
	want := errors.New("authority failure sentinel")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	called := 0
	binding := &RuntimeBinding{Subject: "subject_main", Runtime: bindingSource(func(actual context.Context, subject string) (runtimebridge.Binding, error) {
		called++
		if actual != ctx || actual.Err() != context.Canceled || subject != "subject_main" {
			t.Fatal("binding replaced caller cancellation or subject")
		}
		return runtimebridge.Binding{}, want
	})}
	if result, err := binding.BindingContext(ctx); !errors.Is(err, want) || result != (runtimebridge.Binding{}) || called != 1 {
		t.Fatal("authority unavailability was hidden as an empty or stale runtime")
	}
}
