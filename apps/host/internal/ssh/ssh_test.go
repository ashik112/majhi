package ssh

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"majhi/host/internal/hostlog"
	"majhi/host/internal/platform"
	"majhi/host/internal/run"
)

type agent struct{}

func (agent) Socket() string                { return "/fake/agent.sock" }
func (agent) Passphrases() platform.Keeping { return platform.KeepNone }

type noKeyring struct{}

func (noKeyring) Read(platform.KeyringItem) (string, bool, error) { return "", false, nil }
func (noKeyring) Write(platform.KeyringItem, string) error        { return nil }
func (noKeyring) Remove(platform.KeyringItem) error               { return nil }

const right = "correct horse battery"

// The throwaway askpass folder, with the passphrase in it, is removed after the job whether the
// passphrase was right, wrong or the tool never asked (guarantee: ssh askpass).
func TestAskpassFolderIsRemovedAfterTheJob(t *testing.T) {
	home := t.TempDir()
	key := filepath.Join(home, ".ssh", "id_ed25519")
	if err := os.MkdirAll(filepath.Dir(key), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(key, []byte("private"), 0o600); err != nil {
		t.Fatal(err)
	}
	runtimeDir := filepath.Join(home, "run")
	if err := os.Mkdir(runtimeDir, 0o700); err != nil {
		t.Fatal(err)
	}
	var folders []string
	var anyArgv, anyEnv []string
	mode := "right"
	fake := func(file string, args []string, o run.Options) run.Result {
		anyArgv = append(anyArgv, strings.Join(args, " "))
		for _, v := range o.Env {
			anyEnv = append(anyEnv, v)
		}
		switch filepath.Base(file) {
		case "ssh-keygen":
			if args[0] == "-y" {
				return run.Result{Code: 1, Stderr: "Load key: incorrect passphrase supplied to decrypt private key"}
			}
			return run.Result{Code: 0, Stdout: "256 SHA256:abcdefghij user (ED25519)\n"}
		case "ssh-add":
			if args[0] == "-l" {
				return run.Result{Code: 1}
			}
			script := o.Env["SSH_ASKPASS"]
			if script == "" || mode == "not-asked" {
				return run.Result{Code: 1, Stderr: "agent refused"}
			}
			folders = append(folders, filepath.Dir(script))
			// ssh-add runs the askpass for the passphrase, and again when it was wrong.
			given, err := exec.Command(script).Output()
			if err != nil {
				t.Fatal(err)
			}
			if mode == "right" && strings.TrimSpace(string(given)) == right {
				return run.Result{Code: 0}
			}
			_ = exec.Command(script).Run()
			return run.Result{Code: 1}
		}
		return run.Result{}
	}
	s := New(Deps{
		Run: fake, ReadText: func(string) (string, bool) { return "", false },
		Exists: func(p string) bool { _, err := os.Stat(p); return err == nil },
		Home:   home, Path: "/usr/bin", Find: func(name string) string { return "/usr/bin/" + name },
		Agent: agent{}, Keyring: noKeyring{}, Log: hostlog.Discard(), RuntimeDir: runtimeDir, TmpRoot: t.TempDir(),
	})
	status, err := s.Reload()
	if err != nil || len(status.NeedsPassphrase) != 1 {
		t.Fatalf("%+v %v", status, err)
	}
	for _, c := range []struct{ mode, passphrase string }{
		{"right", right}, {"wrong", "nope"}, {"not-asked", "anything"},
	} {
		mode = c.mode
		folders = nil
		_, err := s.Unlock("~/.ssh/id_ed25519", c.passphrase)
		if (c.mode == "right") != (err == nil) {
			t.Fatalf("%s: %v", c.mode, err)
		}
		if err != nil && strings.Contains(err.Error(), c.passphrase) {
			t.Fatalf("the passphrase is in the error: %v", err)
		}
		if c.mode != "not-asked" && len(folders) == 0 {
			t.Fatalf("%s: the askpass never ran", c.mode)
		}
		for _, dir := range folders {
			if _, err := os.Stat(dir); !os.IsNotExist(err) {
				t.Fatalf("%s: %s is still there", c.mode, dir)
			}
			if filepath.Dir(dir) != runtimeDir {
				t.Fatalf("%s: the folder was made in %s, not the runtime folder", c.mode, filepath.Dir(dir))
			}
		}
		entries, _ := os.ReadDir(runtimeDir)
		if len(entries) != 0 {
			t.Fatalf("%s: left %v", c.mode, entries)
		}
	}
	for _, text := range append(anyArgv, anyEnv...) {
		for _, secret := range []string{right, "nope", "anything"} {
			if strings.Contains(text, secret) {
				t.Fatalf("a passphrase is on a command line or in an environment: %q", text)
			}
		}
	}
}
