package durable

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A crash between any two steps of a write leaves the old file or the new one, never half of one,
// and no temporary file the next write could trip over (guarantee: durable writes).
func TestCrashBetweenStepsLeavesOldOrNew(t *testing.T) {
	crash := errors.New("crash")
	stop := func() error { return crash }
	old, fresh := strings.Repeat("old ", 1000), strings.Repeat("new ", 1000)
	cases := []struct {
		name    string
		hooks   Hooks
		crashes bool
		want    string
	}{
		{"after the temporary file is written", Hooks{AfterTemp: stop}, true, old},
		{"after it is synced", Hooks{AfterSync: stop}, true, old},
		{"after it is renamed", Hooks{AfterRename: stop}, true, fresh},
		{"with no crash", Hooks{}, false, fresh},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			dir := t.TempDir()
			file := filepath.Join(dir, "update-transaction.json")
			if err := os.WriteFile(file, []byte(old), 0o600); err != nil {
				t.Fatal(err)
			}
			err := WriteTextHooked(file, fresh, c.hooks)
			if c.crashes != (err != nil) {
				t.Fatalf("err %v", err)
			}
			got, readErr := os.ReadFile(file)
			if readErr != nil || string(got) != c.want {
				t.Fatalf("the file holds %d bytes of neither the old nor the new content", len(got))
			}
			entries, _ := os.ReadDir(dir)
			if len(entries) != 1 {
				t.Fatalf("a temporary file was left: %v", entries)
			}
			info, _ := os.Stat(file)
			if info.Mode().Perm() != 0o600 && c.want == old {
				t.Fatalf("mode %v", info.Mode())
			}
		})
	}
}

func TestRemoveOfAMissingFileIsFine(t *testing.T) {
	if err := Remove(filepath.Join(t.TempDir(), "nothing")); err != nil {
		t.Fatal(err)
	}
}
