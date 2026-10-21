package update

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

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
// the next start goes back from there.
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

func (j *Journal) validate() error {
	if j.Version != 1 {
		return errors.New("the update journal has an unknown version")
	}
	switch j.Phase {
	case PhasePrepared, PhaseSnapshotting, PhaseStarting, PhaseCommitted:
	default:
		return errors.New("the update journal has an unknown phase")
	}
	if j.Previous == nil {
		j.Previous = []KeptImage{}
	}
	for _, kept := range j.Previous {
		if (kept.Image != ServerImage && kept.Image != RunnerImage && kept.Image != LayaImage) || kept.ID == "" {
			return errors.New("the update journal names an image it should not")
		}
	}
	if j.Moved != nil && j.Moved.Files != nil {
		if err := checkout.CheckRuntimeFiles(j.Moved.Files); err != nil {
			return err
		}
	}
	return nil
}

// ReadJournal reads the journal. It returns nil when there is none. A journal that does not parse is an error.
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
		return nil, fmt.Errorf("the update journal is not valid: %w", err)
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
