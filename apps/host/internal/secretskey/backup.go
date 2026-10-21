// Package secretskey keeps the copy of the secrets key in the OS keyring and puts a restored key
// back, never replacing a key that works. The key goes to the keyring on stdin, never in an
// argument, and is never logged or put in an error.
package secretskey

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"majhi/host/internal/hostlog"
	"majhi/host/internal/platform"
	"majhi/host/internal/protocol"
)

const identityPrefix = "AGE-SECRET-KEY-1"

// isIdentityLine is the whole identity line, so nothing in it can break the keyring call it goes into.
func isIdentityLine(s string) bool {
	rest, ok := strings.CutPrefix(s, identityPrefix)
	if !ok || rest == "" {
		return false
	}
	for _, r := range rest {
		if !((r >= '0' && r <= '9') || (r >= 'A' && r <= 'Z')) {
			return false
		}
	}
	return true
}

// Fingerprint is the first 16 hex characters of the SHA-256 of the identity line. The server computes the same.
func Fingerprint(identity string) string {
	sum := sha256.Sum256([]byte(identity))
	return hex.EncodeToString(sum[:])[:16]
}

// IdentityOf is the first `AGE-SECRET-KEY-1...` line of a key file, as the server reads it.
func IdentityOf(text string) (string, bool) {
	for _, line := range strings.Split(text, "\n") {
		if line = strings.TrimSpace(line); strings.HasPrefix(line, identityPrefix) {
			return line, true
		}
	}
	return "", false
}

func shown(state protocol.KeyringState) string {
	if state.Kind == protocol.KeyringNone {
		return "none, " + state.Reason
	}
	return state.Kind
}

// BackupDeps are what the keyring copy needs.
type BackupDeps struct {
	Keyring platform.Keyring
	// Where is how messages name the keyring: "the Keychain" or "the keyring".
	Where string
	// ReadText is the file's text, or ok false when it does not exist.
	ReadText func(path string) (string, bool)
	// KeyFile is the secrets key file on this computer.
	KeyFile string
	Log     hostlog.Logger
	Now     func() time.Time
}

// Backup keeps a copy of the secrets key in the OS keyring: the login Keychain on macOS, a Secret
// Service keyring on Linux and WSL2.
type Backup struct {
	d     BackupDeps
	mu    sync.Mutex
	last  *protocol.SecretsKeyBackup
	state *protocol.KeyringState
	// ensureLock makes one look at a time.
	ensureLock sync.Mutex
}

// NewBackup builds it.
func NewBackup(d BackupDeps) *Backup {
	if d.Now == nil {
		d.Now = time.Now
	}
	return &Backup{d: d}
}

// Where is how messages name the keyring.
func (b *Backup) Where() string { return b.d.Where }

// Status is the last look, for the poll header. Nil before the first look and while no keyring runs.
func (b *Backup) Status() *protocol.SecretsKeyBackup {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.last == nil {
		return nil
	}
	copied := *b.last
	return &copied
}

// Keyring is the last keyring check, for the poll header. Nil before the first.
func (b *Backup) Keyring() *protocol.KeyringState {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.state == nil {
		return nil
	}
	copied := *b.state
	return &copied
}

func (b *Backup) note(saved, errText string) protocol.SecretsKeyBackup {
	last := protocol.SecretsKeyBackup{Error: errText, CheckedAt: b.d.Now().UTC().Format("2006-01-02T15:04:05.000Z")}
	if saved != "" {
		last.Saved = Fingerprint(saved)
	}
	b.mu.Lock()
	b.last = &last
	b.mu.Unlock()
	return last
}

// check asks whether a keyring answers, and logs the answer when it changed.
func (b *Backup) check() protocol.KeyringState {
	next := b.d.Keyring.Check()
	b.mu.Lock()
	changed := b.state == nil || shown(*b.state) != shown(next)
	b.state = &next
	if next.Kind == protocol.KeyringNone {
		b.last = nil
	}
	b.mu.Unlock()
	if changed {
		b.d.Log("keyring: " + shown(next))
	}
	return next
}

func (b *Backup) read() (string, bool, error) {
	secret, found, err := b.d.Keyring.Read(platform.SecretsKeyItem)
	if err != nil || !found {
		return "", false, err
	}
	identity := strings.TrimSpace(secret)
	if !isIdentityLine(identity) {
		return "", false, nil
	}
	return identity, true, nil
}

func (b *Backup) write(identity string) error {
	if !isIdentityLine(identity) {
		return errors.New("The secrets key file does not hold a key.")
	}
	if err := b.d.Keyring.Write(platform.SecretsKeyItem, identity); err != nil {
		return err
	}
	b.d.Log("secrets key: saved a copy in " + b.d.Where)
	return nil
}

func (b *Backup) fileKey() (string, bool) {
	text, ok := b.d.ReadText(b.d.KeyFile)
	if !ok {
		return "", false
	}
	return IdentityOf(text)
}

// Ensure checks the keyring, then saves the key when it holds none. It never replaces another key.
// It does nothing while no keyring runs. It never fails.
func (b *Backup) Ensure() *protocol.SecretsKeyBackup {
	b.ensureLock.Lock()
	defer b.ensureLock.Unlock()
	if b.check().Kind == protocol.KeyringNone {
		return nil
	}
	fail := func(err error) *protocol.SecretsKeyBackup {
		b.d.Log("secrets key: " + err.Error())
		last := b.note("", err.Error())
		return &last
	}
	saved, found, err := b.read()
	if err != nil {
		return fail(err)
	}
	if found {
		last := b.note(saved, "")
		return &last
	}
	key, ok := b.fileKey()
	if !ok {
		last := b.note("", "")
		return &last
	}
	if err := b.write(key); err != nil {
		return fail(err)
	}
	last := b.note(key, "")
	return &last
}

// Save saves the key file over whatever the keyring holds, when the file is the expected key.
func (b *Backup) Save(expected string) (protocol.SecretsKeyBackup, error) {
	keyring := b.check()
	if keyring.Kind == protocol.KeyringNone {
		return protocol.SecretsKeyBackup{}, errors.New(keyring.Reason + " The copy was not saved.")
	}
	key, ok := b.fileKey()
	if !ok {
		return protocol.SecretsKeyBackup{}, fmt.Errorf("There is no secrets key at %s.", b.d.KeyFile)
	}
	if Fingerprint(key) != expected {
		return protocol.SecretsKeyBackup{}, fmt.Errorf("The key at %s is not the key majhi uses, so it was not saved.", b.d.KeyFile)
	}
	if err := b.write(key); err != nil {
		return protocol.SecretsKeyBackup{}, err
	}
	return b.note(key, ""), nil
}

// Read is the key the keyring holds, to put back a lost key file. False when there is none.
func (b *Backup) Read() (string, bool) {
	key, found, err := b.read()
	if err != nil {
		return "", false
	}
	return key, found
}

// fileExists is for the restore.
func fileExists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}
