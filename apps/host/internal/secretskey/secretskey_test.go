package secretskey

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"filippo.io/age"

	"majhi/host/internal/hostlog"
	"majhi/host/internal/platform"
	"majhi/host/internal/protocol"
)

type memKeyring struct {
	items  map[string]string
	writes int
}

func (m *memKeyring) Check() protocol.KeyringState {
	return protocol.KeyringState{Kind: protocol.KeyringKeychain}
}
func (m *memKeyring) Read(item platform.KeyringItem) (string, bool, error) {
	v, ok := m.items[item.Service]
	return v, ok, nil
}
func (m *memKeyring) Write(item platform.KeyringItem, secret string) error {
	m.writes++
	m.items[item.Service] = secret
	return nil
}
func (m *memKeyring) Remove(item platform.KeyringItem) error {
	delete(m.items, item.Service)
	return nil
}

func newKey(t *testing.T) string {
	t.Helper()
	id, err := age.GenerateX25519Identity()
	if err != nil {
		t.Fatal(err)
	}
	return id.String()
}

func readFile(path string) (string, bool) {
	data, err := os.ReadFile(path)
	return string(data), err == nil
}

// The keyring copy is made when there is none, and a different key already there is never replaced
// by the helper looking again (guarantee: keyring).
func TestEnsureNeverReplacesADifferentKeyInTheKeyring(t *testing.T) {
	dir := t.TempDir()
	fileKey, keyringKey := newKey(t), newKey(t)
	keyFile := filepath.Join(dir, "secrets.key")
	if err := os.WriteFile(keyFile, []byte(fileKey+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	ring := &memKeyring{items: map[string]string{platform.SecretsKeyItem.Service: keyringKey}}
	backup := NewBackup(BackupDeps{Keyring: ring, Where: "the keyring", ReadText: readFile, KeyFile: keyFile, Log: hostlog.Discard()})
	status := backup.Ensure()
	if ring.writes != 0 || ring.items[platform.SecretsKeyItem.Service] != keyringKey {
		t.Fatal("the key in the keyring was replaced")
	}
	if status == nil || status.Saved != Fingerprint(keyringKey) {
		t.Fatalf("status %+v", status)
	}
	// With none there, the file's key is saved.
	empty := &memKeyring{items: map[string]string{}}
	backup = NewBackup(BackupDeps{Keyring: empty, Where: "the keyring", ReadText: readFile, KeyFile: keyFile, Log: hostlog.Discard()})
	if status := backup.Ensure(); status == nil || status.Saved != Fingerprint(fileKey) || empty.writes != 1 {
		t.Fatalf("status %+v", status)
	}
	// An explicit save replaces it, but only with the key the server uses.
	if _, err := backup.Save(Fingerprint(keyringKey)); err == nil || strings.Contains(err.Error(), fileKey) {
		t.Fatalf("saved a key that is not the server's: %v", err)
	}
}

// A key file that works is never replaced by a restore, and a key that does not open secrets.age is
// refused (guarantee 47).
func TestRestoreNeverReplacesAWorkingKeyFile(t *testing.T) {
	dir := t.TempDir()
	key, other := newKey(t), newKey(t)
	id, _ := age.ParseX25519Identity(key)
	sealedPath := filepath.Join(dir, "secrets.age")
	f, err := os.Create(sealedPath)
	if err != nil {
		t.Fatal(err)
	}
	w, err := age.Encrypt(f, id.Recipient())
	if err != nil {
		t.Fatal(err)
	}
	_, _ = w.Write([]byte("hello"))
	_ = w.Close()
	_ = f.Close()
	keyFile := filepath.Join(dir, "config", "secrets.key")
	files := KeyFiles{KeyFile: keyFile, SecretsFile: sealedPath}

	if _, err := WriteRestoredKey(other, files); err == nil || !strings.Contains(err.Error(), "does not open secrets.age") {
		t.Fatalf("a key that does not open secrets.age: %v", err)
	}
	if _, err := WriteRestoredKey("AGE-SECRET-KEY-1NOTAKEY", files); err == nil {
		t.Fatal("accepted something that is not a key")
	}
	if _, err := os.Stat(keyFile); !os.IsNotExist(err) {
		t.Fatal("a refused restore wrote a file")
	}
	// Missing file: written, mode 600 in a folder of 700.
	write, err := WriteRestoredKey(key, files)
	if err != nil || !write.Written || write.KeptAside != "" {
		t.Fatalf("%+v %v", write, err)
	}
	if info, _ := os.Stat(keyFile); info.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", info.Mode())
	}
	if info, _ := os.Stat(filepath.Dir(keyFile)); info.Mode().Perm() != 0o700 {
		t.Fatalf("folder mode %v", info.Mode())
	}
	// A file that works is left alone, the same key or another that also opens it.
	if write, err := WriteRestoredKey(key, files); err != nil || write.Written {
		t.Fatalf("%+v %v", write, err)
	}
	// A broken file is moved aside, never deleted.
	if err := os.WriteFile(keyFile, []byte("garbage\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	write, err = WriteRestoredKey(key, files)
	if err != nil || !write.Written || !strings.Contains(write.KeptAside, "secrets.key.old-") {
		t.Fatalf("%+v %v", write, err)
	}
	if kept, _ := os.ReadFile(write.KeptAside); string(kept) != "garbage\n" {
		t.Fatal("the old file was lost")
	}
	// What Docker makes for a missing mount, a folder, is moved aside too.
	if err := os.Remove(keyFile); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(keyFile, 0o755); err != nil {
		t.Fatal(err)
	}
	if write, err := WriteRestoredKey(key, files); err != nil || write.KeptAside == "" {
		t.Fatalf("%+v %v", write, err)
	}
}
