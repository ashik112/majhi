// Package durable writes files so that a crash between steps leaves the old file or the new one,
// never half of one: a temporary file made with O_EXCL, fsynced, renamed over the target, and the
// folder fsynced.
package durable

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

// Hooks name the steps a write goes through, so a test can stop it between any two of them.
// A hook that returns an error ends the write at that step, as a crash would.
type Hooks struct {
	AfterTemp   func() error
	AfterSync   func() error
	AfterRename func() error
}

// WriteText replaces file with text (mode 0600) in the safe order.
func WriteText(file, text string) error { return WriteTextHooked(file, text, Hooks{}) }

// WriteTextHooked is WriteText with steps a test can interrupt.
func WriteTextHooked(file, text string, hooks Hooks) (err error) {
	temp, err := tempName(file)
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			_ = os.Remove(temp)
		}
	}()
	f, err := os.OpenFile(temp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return fmt.Errorf("make %s: %w", temp, err)
	}
	if _, err := f.WriteString(text); err != nil {
		_ = f.Close()
		return fmt.Errorf("write %s: %w", temp, err)
	}
	if err := step(hooks.AfterTemp); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		return fmt.Errorf("sync %s: %w", temp, err)
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("close %s: %w", temp, err)
	}
	if err := step(hooks.AfterSync); err != nil {
		return err
	}
	if err := os.Rename(temp, file); err != nil {
		return fmt.Errorf("rename %s: %w", temp, err)
	}
	if err := step(hooks.AfterRename); err != nil {
		return err
	}
	return syncDir(filepath.Dir(file))
}

func step(hook func() error) error {
	if hook == nil {
		return nil
	}
	return hook()
}

func tempName(file string) (string, error) {
	raw := make([]byte, 8)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("make a temporary name: %w", err)
	}
	return file + "." + hex.EncodeToString(raw) + ".tmp", nil
}

// WriteJSON replaces file with the JSON of value.
func WriteJSON(file string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("encode %s: %w", file, err)
	}
	return WriteText(file, string(data))
}

// Remove deletes file and makes the deletion durable. A file that is not there is fine.
func Remove(file string) error {
	if err := os.Remove(file); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("remove %s: %w", file, err)
	}
	return syncDir(filepath.Dir(file))
}

// IsMissing is true for an error that says a file is not there.
func IsMissing(err error) bool { return errors.Is(err, os.ErrNotExist) }

// syncDir persists the folder's entry. Windows cannot open a folder to sync it.
func syncDir(dir string) error {
	if runtime.GOOS == "windows" {
		return nil
	}
	d, err := os.Open(dir)
	if err != nil {
		return fmt.Errorf("open %s: %w", dir, err)
	}
	defer d.Close()
	if err := d.Sync(); err != nil {
		return fmt.Errorf("sync %s: %w", dir, err)
	}
	return nil
}
