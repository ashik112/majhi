// Package hostlog writes the helper's log file: timestamped lines in
// <MAJHI_HOME>/logs/host.log, with one older file kept as host.log.1.
package hostlog

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Logger writes one line. It never fails the caller.
type Logger func(message string)

// MaxBytes is the size at which the log moves to <file>.1.
const MaxBytes = 1_000_000

// Discard is a Logger that drops every line.
func Discard() Logger { return func(string) {} }

// NewFile appends timestamped lines to path, keeping one older file (<path>.1).
// Writes are synchronous under one lock, so lines stay in order and survive a crash.
func NewFile(path string, maxBytes int64) (Logger, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, fmt.Errorf("make the log folder: %w", err)
	}
	var mu sync.Mutex
	tty := false
	if info, err := os.Stdout.Stat(); err == nil {
		tty = info.Mode()&os.ModeCharDevice != 0
	}
	return func(message string) {
		line := time.Now().UTC().Format("2006-01-02T15:04:05.000Z") + " " + message + "\n"
		mu.Lock()
		defer mu.Unlock()
		if tty {
			_, _ = os.Stdout.WriteString(line)
		}
		if err := appendLine(path, line, maxBytes); err != nil {
			// Logging must never stop the helper. The login service appends stderr to host.out.
			fmt.Fprintf(os.Stderr, "majhi-host: cannot write %s: %v\n%s", path, err, line)
		}
	}, nil
}

func appendLine(path, line string, maxBytes int64) error {
	if info, err := os.Stat(path); err == nil && info.Size() > 0 && info.Size()+int64(len(line)) > maxBytes {
		if err := os.Rename(path, path+".1"); err != nil {
			return err
		}
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.WriteString(line)
	return err
}
