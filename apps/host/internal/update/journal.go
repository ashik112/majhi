package update

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"majhi/host/internal/checkout"
	"majhi/host/internal/durable"
)

const journalFile = "update-transaction.json"

// The phases of an update transaction.
const (
	PhasePrepared     = "prepared"
	PhaseSnapshotting = "snapshotting"
	PhaseStarting     = "starting"
	PhaseCommitted    = "committed"
)

// KeptImage is an image that ran before the update: its tag and the id the tag pointed at.
type KeptImage struct {
	Image string `json:"image"`
	ID    string `json:"id"`
}

// Journal is the update transaction on disk. A crash at any step leaves it at the last phase, and
// the next start goes back from there. What it says is acted on (images are tagged, a checkout is
// moved, a compose file is written), so it is checked before anything runs.
type Journal struct {
	Version  int             `json:"version"`
	Phase    string          `json:"phase"`
	Previous []KeptImage     `json:"previous"`
	Mounts   *string         `json:"mounts,omitempty"`
	Moved    *checkout.Moved `json:"moved,omitempty"`
}

// The images an update keeps.
const (
	ServerImage = "majhi-server:dev"
	RunnerImage = "majhi-runner:dev"
	LayaImage   = "majhi-laya:dev"
)

// InvalidJournalError says a journal on disk is not one this helper wrote, or was cut short.
type InvalidJournalError struct{ Reason string }

func (e *InvalidJournalError) Error() string { return "the update journal is not valid: " + e.Reason }

func invalid(format string, args ...any) error {
	return &InvalidJournalError{Reason: fmt.Sprintf(format, args...)}
}

func isLowerHex(s string) bool {
	for _, r := range s {
		if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f')) {
			return false
		}
	}
	return s != ""
}

// IsObjectID is a full git object id: 40 or 64 lowercase hex characters, so never an option.
func IsObjectID(s string) bool { return (len(s) == 40 || len(s) == 64) && isLowerHex(s) }

// IsImageID is a Docker image id as `docker image inspect` prints it: `sha256:` and 64 hex characters.
func IsImageID(s string) bool {
	rest, ok := strings.CutPrefix(s, "sha256:")
	return ok && len(rest) == 64 && isLowerHex(rest)
}

func (j *Journal) validate() error {
	if j.Version != 1 {
		return invalid("unknown version")
	}
	switch j.Phase {
	case PhasePrepared, PhaseSnapshotting, PhaseStarting, PhaseCommitted:
	default:
		return invalid("unknown phase")
	}
	if j.Previous == nil {
		j.Previous = []KeptImage{}
	}
	for _, kept := range j.Previous {
		if kept.Image != ServerImage && kept.Image != RunnerImage && kept.Image != LayaImage {
			return invalid("it names an image the update does not keep")
		}
		if !IsImageID(kept.ID) {
			return invalid("an image id is not a sha256 id")
		}
	}
	if m := j.Moved; m != nil {
		if m.From == "" || m.To == "" || m.Head == "" || m.Dotenv == "" {
			return invalid("the moved release lacks a field")
		}
		if !IsObjectID(m.Head) {
			return invalid("the moved release's head is not a commit id")
		}
		if m.Files != nil {
			if err := checkout.CheckRuntimeFiles(m.Files); err != nil {
				return invalid("%v", err)
			}
		}
	}
	return nil
}

// ReadJournal reads the journal. It returns nil when there is none. A journal that does not parse or
// does not pass the checks is an *InvalidJournalError; any other error is a file error.
func ReadJournal(home string) (*Journal, error) {
	data, err := os.ReadFile(filepath.Join(home, journalFile))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var j Journal
	if err := json.Unmarshal(data, &j); err != nil {
		return nil, invalid("%v", err)
	}
	if err := j.validate(); err != nil {
		return nil, err
	}
	return &j, nil
}

// WriteJournal replaces the journal durably.
func WriteJournal(home string, j Journal) error {
	if err := j.validate(); err != nil {
		return err
	}
	return durable.WriteJSON(filepath.Join(home, journalFile), j)
}

// ClearJournal removes the journal durably.
func ClearJournal(home string) error { return durable.Remove(filepath.Join(home, journalFile)) }

// QuarantineJournal moves a journal that was refused to `update-transaction.json.bad-<UTC time>`, so
// it is kept for the owner to look at and never acted on. It returns where it went.
func QuarantineJournal(home string, now time.Time) (string, error) {
	from := filepath.Join(home, journalFile)
	to := from + ".bad-" + now.UTC().Format("20060102T150405Z")
	if err := os.Rename(from, to); err != nil {
		return "", err
	}
	return to, nil
}
