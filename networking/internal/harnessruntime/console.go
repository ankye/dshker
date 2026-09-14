package harnessruntime

import (
	"regexp"
	"strings"
	"sync"
	"time"
)

// MaxConsoleEntries is the shell's own bound on the in-memory feed. The durable
// log file is what survives past it.
const MaxConsoleEntries = 1_000

// Console stream names. "command" is pnpm's own one-line script echo, which the
// shell renders as a command rather than as a diagnostic even though pnpm writes
// it to standard error.
const (
	StreamStdout  = "stdout"
	StreamStderr  = "stderr"
	StreamCommand = "command"
	StreamLaunch  = "launcher"
)

// ConsoleEntry is one renderer-visible console record. Sequence numbers are
// monotonic, which is how the shell unions snapshots with pushed entries.
type ConsoleEntry struct {
	Sequence       int64  `json:"seq"`
	Stream         string `json:"stream"`
	Text           string `json:"text"`
	OccurredAtUnix int64  `json:"occurredAt"`
}

// Console is a bounded, append-only feed that readers drain by cursor. A reader
// that asks for entries after a sequence the cap has already discarded receives
// everything still retained rather than an error.
type Console struct {
	mutex   sync.Mutex
	entries []ConsoleEntry
	next    int64
}

// Append records one entry and returns it.
func (console *Console) Append(stream string, text string, at time.Time) ConsoleEntry {
	console.mutex.Lock()
	defer console.mutex.Unlock()
	console.next++
	entry := ConsoleEntry{
		Sequence:       console.next,
		Stream:         stream,
		Text:           text,
		OccurredAtUnix: at.UnixMilli(),
	}
	console.entries = append(console.entries, entry)
	if len(console.entries) > MaxConsoleEntries {
		console.entries = append([]ConsoleEntry(nil), console.entries[len(console.entries)-MaxConsoleEntries:]...)
	}
	return entry
}

// After returns every retained entry newer than one sequence, plus the cursor to
// pass next. A cursor of zero reads the whole retained tail.
func (console *Console) After(sequence int64) ([]ConsoleEntry, int64) {
	console.mutex.Lock()
	defer console.mutex.Unlock()
	entries := make([]ConsoleEntry, 0, len(console.entries))
	for _, entry := range console.entries {
		if entry.Sequence > sequence {
			entries = append(entries, entry)
		}
	}
	return entries, console.next
}

// Latest returns the newest sequence the feed has issued.
func (console *Console) Latest() int64 {
	console.mutex.Lock()
	defer console.mutex.Unlock()
	return console.next
}

// pnpmCommandEchoPattern recognizes pnpm's one-line script echo, which it writes
// to standard error but which is not a diagnostic.
var pnpmCommandEchoPattern = regexp.MustCompile(`^\$\s+\S[^\r\n]*(?:\r?\n)?$`)

// ClassifyChildConsoleStream separates pnpm's one-line script echo from
// diagnostics written to standard error.
func ClassifyChildConsoleStream(stream string, text string) string {
	if stream == StreamStderr && pnpmCommandEchoPattern.MatchString(text) {
		return StreamCommand
	}
	return stream
}

// LineObserver reads the announced URL from complete lines only. Child stdout
// arrives in arbitrary chunks that can split a line mid-URL, and adopting a
// truncated URL would drop the session credential DSH puts in its query.
type LineObserver struct {
	pending string
}

// Reset clears partial-line buffering for a new launch.
func (observer *LineObserver) Reset() { observer.pending = "" }

// Observe consumes one output fragment and returns the announced URL when a
// complete line carries one.
func (observer *LineObserver) Observe(text string) (string, bool) {
	if text == "" {
		return "", false
	}
	observer.pending += text
	announced := ""
	found := false
	for {
		index := strings.IndexByte(observer.pending, '\n')
		if index < 0 {
			break
		}
		line := observer.pending[:index]
		observer.pending = observer.pending[index+1:]
		if url, ok := ParseAnnouncedWebURL(line); ok {
			announced, found = url, true
		}
	}
	return announced, found
}
