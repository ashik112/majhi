package update

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A journal cut short is an error, never a half-read transaction that would send an update the wrong way.
func TestAHalfWrittenJournalIsNeverRead(t *testing.T) {
	home := t.TempDir()
	mounts := "services: {}\n"
	journal := Journal{Version: 1, Phase: PhaseStarting, Previous: []KeptImage{{Image: ServerImage, ID: "sha256:" + strings.Repeat("a", 64)}}, Mounts: &mounts}
	if err := WriteJournal(home, journal); err != nil {
		t.Fatal(err)
	}
	read, err := ReadJournal(home)
	if err != nil || read == nil || read.Phase != PhaseStarting || read.Previous[0].ID != "sha256:"+strings.Repeat("a", 64) || *read.Mounts != mounts {
		t.Fatalf("%+v %v", read, err)
	}
	file := filepath.Join(home, journalFile)
	data, _ := os.ReadFile(file)
	for cut := 1; cut < len(data); cut += 7 {
		if err := os.WriteFile(file, data[:cut], 0o600); err != nil {
			t.Fatal(err)
		}
		if read, err := ReadJournal(home); err == nil {
			t.Fatalf("a journal cut at %d of %d bytes was read: %+v", cut, len(data), read)
		}
	}
	// It cannot name an image the update does not keep, or a phase that does not exist.
	for _, bad := range []string{
		`{"version":1,"phase":"starting","previous":[{"image":"evil:latest","id":"x"}]}`,
		`{"version":1,"phase":"sideways","previous":[]}`,
		`{"version":2,"phase":"prepared","previous":[]}`,
	} {
		if err := os.WriteFile(file, []byte(bad), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := ReadJournal(home); err == nil {
			t.Fatalf("read %s", bad)
		}
	}
	if err := ClearJournal(home); err != nil {
		t.Fatal(err)
	}
	if read, err := ReadJournal(home); read != nil || err != nil {
		t.Fatal("the journal is still there")
	}
}
