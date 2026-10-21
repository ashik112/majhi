package secretskey

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"filippo.io/age"

	"majhi/host/internal/hostlog"
	"majhi/host/internal/protocol"
)

// The messages of a restore that is refused.
const (
	NotAKey      = "The restored key is not a secrets key, so the key file was left as it is."
	DoesNotOpen  = "The restored key does not open secrets.age, so the key file was left as it is."
	KeyFileWorks = "The key file already holds a working key, so it was not replaced."
	// asideTries is more old key files with the same second than anyone makes by hand.
	asideTries = 100
)

// KeyFiles are the files a restore touches.
type KeyFiles struct {
	// KeyFile is the secrets key file Docker mounts into majhi.
	KeyFile string
	// SecretsFile is `<MAJHI_HOME>/secrets.age`, the file the key opens.
	SecretsFile string
	Now         func() time.Time
}

// KeyWrite is what writing a restored key did.
type KeyWrite struct {
	// Written is false when the key file already held this key.
	Written   bool
	KeptAside string
}

// isIdentity is true for one `AGE-SECRET-KEY-1...` line age reads as an X25519 identity.
func isIdentity(line string) bool {
	if len(line) > 256 || !isIdentityLine(line) {
		return false
	}
	_, err := age.ParseX25519Identity(line)
	return err == nil
}

// opens is true when the identity decrypts the sealed file all the way, authentication included.
func opens(identity string, sealed []byte) bool {
	id, err := age.ParseX25519Identity(identity)
	if err != nil {
		return false
	}
	r, err := age.Decrypt(bytes.NewReader(sealed), id)
	if err != nil {
		return false
	}
	_, err = io.ReadAll(r)
	return err == nil
}

func readOptional(path string) ([]byte, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	return data, err
}

// currentKey is the key line in the key file, as the server reads it. False when there is no file or no key in it.
func currentKey(keyFile string) (string, bool, error) {
	if info, err := os.Stat(keyFile); err == nil && info.IsDir() {
		return "", false, nil
	}
	data, err := os.ReadFile(keyFile)
	if errors.Is(err, fs.ErrNotExist) || errors.Is(err, syscall.EISDIR) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	key, ok := IdentityOf(string(data))
	return key, ok, nil
}

// WriteRestoredKey writes a restored secrets key to the key file, mode 600 in a folder of mode 700.
// Only when the file is missing or its key does not open secrets.age, and only a key that opens
// secrets.age. Before there is a secrets.age, any valid key in the file counts as working. Whatever
// was at the path (a file, or the folder Docker makes for a missing one) is renamed aside, never
// deleted. Errors are fixed sentences or file errors: never the key.
func WriteRestoredKey(key string, files KeyFiles) (KeyWrite, error) {
	if !isIdentity(key) {
		return KeyWrite{}, errors.New(NotAKey)
	}
	sealed, err := readOptional(files.SecretsFile)
	if err != nil {
		return KeyWrite{}, err
	}
	if sealed != nil && !opens(key, sealed) {
		return KeyWrite{}, errors.New(DoesNotOpen)
	}
	current, hasCurrent, err := currentKey(files.KeyFile)
	if err != nil {
		return KeyWrite{}, err
	}
	works := false
	if hasCurrent {
		if sealed == nil {
			works = isIdentity(current)
		} else {
			works = opens(current, sealed)
		}
	}
	if works {
		if current == key {
			return KeyWrite{}, nil
		}
		return KeyWrite{}, errors.New(KeyFileWorks)
	}

	folder := filepath.Dir(files.KeyFile)
	if err := os.MkdirAll(folder, 0o700); err != nil {
		return KeyWrite{}, err
	}
	if err := os.Chmod(folder, 0o700); err != nil {
		return KeyWrite{}, err
	}
	suffix := make([]byte, 6)
	if _, err := rand.Read(suffix); err != nil {
		return KeyWrite{}, err
	}
	temp := fmt.Sprintf("%s.%d.%s.tmp", files.KeyFile, os.Getpid(), hex.EncodeToString(suffix))
	defer os.Remove(temp)
	// O_EXCL: never follows or reuses a file that is already there.
	f, err := os.OpenFile(temp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return KeyWrite{}, err
	}
	if _, err := f.WriteString(key + "\n"); err != nil {
		_ = f.Close()
		return KeyWrite{}, err
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		return KeyWrite{}, err
	}
	if err := f.Close(); err != nil {
		return KeyWrite{}, err
	}
	if err := os.Chmod(temp, 0o600); err != nil {
		return KeyWrite{}, err
	}
	now := time.Now
	if files.Now != nil {
		now = files.Now
	}
	aside, err := keepAside(files.KeyFile, now())
	if err != nil {
		return KeyWrite{}, err
	}
	if err := os.Rename(temp, files.KeyFile); err != nil {
		// Put the old file back, so a failed restore leaves the folder as it was.
		if aside != "" {
			_ = os.Rename(aside, files.KeyFile)
		}
		return KeyWrite{}, err
	}
	return KeyWrite{Written: true, KeptAside: aside}, nil
}

// keepAside renames what is at the key file's path to `<file>.old-<UTC time>`. "" when nothing is there.
func keepAside(keyFile string, now time.Time) (string, error) {
	if !fileExists(keyFile) {
		return "", nil
	}
	stamp := now.UTC().Format("20060102T150405Z")
	for n := 1; n <= asideTries; n++ {
		aside := keyFile + ".old-" + stamp
		if n > 1 {
			aside += fmt.Sprintf("-%d", n)
		}
		if fileExists(aside) {
			continue
		}
		if err := os.Rename(keyFile, aside); err != nil {
			return "", err
		}
		return aside, nil
	}
	return "", fmt.Errorf("Too many old key files next to %s. Move some away and try again.", keyFile)
}

// RestorerDeps are what a restore needs.
type RestorerDeps struct {
	KeyFiles
	// Restart recreates majhi's server so Docker mounts the key file again. Read at each restore:
	// majhi can be restarted once docker is found. Nil when the helper cannot run Docker.
	Restart func() func() error
	// SaveToKeyring saves the key file to the OS keyring when it holds the key with this fingerprint. Nil to keep no copy.
	SaveToKeyring func(fingerprint string) error
	Log           hostlog.Logger
}

// Restorer answers `secretsKey.restore`, one restore at a time. What it logs never holds the key.
type Restorer struct {
	d  RestorerDeps
	mu sync.Mutex
}

// NewRestorer builds it.
func NewRestorer(d RestorerDeps) *Restorer { return &Restorer{d: d} }

// Restore writes the key under the guard of WriteRestoredKey. `after` restarts majhi, then saves
// the key to the keyring; run it after the reply. It never fails.
func (r *Restorer) Restore(key string) (protocol.SecretsKeyRestore, func(), error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	write, err := WriteRestoredKey(key, r.d.KeyFiles)
	if err != nil {
		return protocol.SecretsKeyRestore{}, nil, err
	}
	if write.Written {
		extra := ""
		if write.KeptAside != "" {
			extra = ", the old file is " + write.KeptAside
		}
		r.d.Log("secrets key: restored from its export" + extra)
	} else {
		r.d.Log("secrets key: the key file already holds the restored key")
	}
	fingerprint := Fingerprint(key)
	var restart func() error
	if r.d.Restart != nil {
		restart = r.d.Restart()
	}
	result := protocol.SecretsKeyRestore{Written: write.Written, KeptAside: write.KeptAside, Restarts: restart != nil}
	after := func() {
		if restart != nil {
			if err := restart(); err != nil {
				r.d.Log("secrets key: " + firstLine(err.Error()))
			} else {
				r.d.Log("secrets key: restarted majhi to load the key")
			}
		}
		if r.d.SaveToKeyring != nil {
			if err := r.d.SaveToKeyring(fingerprint); err != nil {
				r.d.Log("secrets key: " + err.Error())
			}
		}
	}
	return result, after, nil
}

func firstLine(text string) string {
	line, _, _ := strings.Cut(text, "\n")
	return line
}
