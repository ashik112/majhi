package platform

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"majhi/host/internal/hostlog"
	"majhi/host/internal/run"
	"majhi/host/internal/sys"
)

type call struct {
	file  string
	args  []string
	input string
	env   map[string]string
}

type recorder struct {
	calls []call
	reply func(file string, args []string, o run.Options) run.Result
}

func (r *recorder) run(file string, args []string, o run.Options) run.Result {
	r.calls = append(r.calls, call{file, args, o.Input, o.Env})
	if r.reply != nil {
		return r.reply(file, args, o)
	}
	return run.Result{}
}

const keyLine = "AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ"

func neverIn(t *testing.T, r *recorder, secret string) {
	t.Helper()
	for _, c := range r.calls {
		if strings.Contains(strings.Join(c.args, " "), secret) {
			t.Fatalf("the secret is on a command line: %s %v", c.file, c.args)
		}
		for k, v := range c.env {
			if strings.Contains(v, secret) {
				t.Fatalf("the secret is in the environment (%s) of %s", k, c.file)
			}
		}
	}
}

// A secret goes to the keyring on stdin: never on a command line or in an environment (guarantee: keyring).
func TestKeyringsTakeASecretOnStdinOnly(t *testing.T) {
	// Linux: libsecret's `secret-tool store` reads it from stdin, then it is read back.
	stored := ""
	linux := &recorder{}
	linux.reply = func(file string, args []string, o run.Options) run.Result {
		switch {
		case strings.HasSuffix(file, "busctl"):
			return run.Result{Stdout: "b false\n"}
		case args[0] == "store":
			stored = o.Input
		case args[0] == "lookup":
			return run.Result{Stdout: stored}
		}
		return run.Result{}
	}
	secrets := secretService{
		run:  linux.run,
		find: func(name string) string { return "/usr/bin/" + name },
		env:  func() map[string]string { return map[string]string{"PATH": "/usr/bin", "HOME": "/h"} },
	}
	if err := secrets.Write(SecretsKeyItem, keyLine); err != nil {
		t.Fatal(err)
	}
	neverIn(t, linux, keyLine)
	if stored != keyLine {
		t.Fatalf("stdin held %q", stored)
	}
	// A keyring that does not hold what was written says so, in plain words, without the secret.
	stored = ""
	deaf := &recorder{reply: func(file string, args []string, o run.Options) run.Result {
		if strings.HasSuffix(file, "busctl") {
			return run.Result{Stdout: "b false\n"}
		}
		return run.Result{Code: 1}
	}}
	deafSecrets := secretService{run: deaf.run, find: secrets.find, env: secrets.env}
	if err := deafSecrets.Write(SecretsKeyItem, keyLine); err == nil || strings.Contains(err.Error(), keyLine) {
		t.Fatalf("error %v", err)
	}

	// macOS: `security -i` takes its commands on stdin, so the secret is in no argument.
	var held string
	mac := &recorder{}
	mac.reply = func(file string, args []string, o run.Options) run.Result {
		if args[0] == "-i" {
			held = "AGE"
			return run.Result{}
		}
		if args[0] == "find-generic-password" {
			return run.Result{Stdout: "ABCDEF-123\n"}
		}
		return run.Result{}
	}
	chain := keychain{run: mac.run}
	if err := chain.Write(SecretsKeyItem, "ABCDEF-123"); err != nil {
		t.Fatal(err)
	}
	neverIn(t, mac, "ABCDEF-123")
	if held == "" || !strings.Contains(mac.calls[0].input, "-w ABCDEF-123") {
		t.Fatalf("stdin %q", mac.calls[0].input)
	}
	// Anything that could break out of the quoted command line is refused before it is run.
	for _, bad := range []string{"", "a b", `a"b`, "a;b", "a\nb"} {
		if err := chain.Write(SecretsKeyItem, bad); err == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
}

func testDeps(t *testing.T, download func(string) ([]byte, error), r *recorder) sys.Deps {
	t.Helper()
	home := t.TempDir()
	return sys.Deps{
		Run: r.run, Env: map[string]string{}, Home: home, MajhiHome: filepath.Join(home, ".majhi"), Path: "/usr/bin",
		Find:   func(string) string { return "" },
		Exists: func(p string) bool { _, err := os.Stat(p); return err == nil },
		Log:    hostlog.Discard(), Download: download,
	}
}

func waitUntil(t *testing.T, ok func() bool) {
	t.Helper()
	for i := 0; i < 400; i++ {
		if ok() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("timed out")
}

// terminal-notifier is installed only when its download matches the pinned SHA-256 (guarantee: release and download checks).
func TestTerminalNotifierWithAnotherChecksumIsRefused(t *testing.T) {
	var downloads atomic.Int32
	r := &recorder{}
	deps := testDeps(t, func(string) ([]byte, error) {
		downloads.Add(1)
		return []byte("not the release"), nil
	}, r)
	finder := &tnFinder{deps: deps, release: TerminalNotifier, now: time.Now}
	if finder.find() != "" {
		t.Fatal("found a notifier before one was installed")
	}
	waitUntil(t, func() bool { finder.mu.Lock(); defer finder.mu.Unlock(); return !finder.installing })
	if len(r.calls) != 0 {
		t.Fatalf("the download was unpacked: %v", r.calls)
	}
	if finder.find() != "" || tnInstalledProgram(deps.MajhiHome) == "" {
		t.Fatal("a refused download was used")
	}
	if _, err := os.Stat(tnInstallDir(deps.MajhiHome)); !os.IsNotExist(err) {
		t.Fatal("something was installed from a download that did not match")
	}
	if downloads.Load() != 1 {
		t.Fatalf("it tried %d times: a mismatch stops tries until the helper restarts", downloads.Load())
	}
}

func TestTerminalNotifierIsInstalledWhenTheChecksumMatches(t *testing.T) {
	payload := []byte("the pinned release")
	sum := sha256.Sum256(payload)
	release := NotifierRelease{Version: "9.9.9", URL: "https://example.test/tn.zip", SHA256: hex.EncodeToString(sum[:])}
	r := &recorder{}
	deps := testDeps(t, func(string) ([]byte, error) { return payload, nil }, r)
	r.reply = func(file string, args []string, o run.Options) run.Result {
		// `ditto -x -k <zip> <unpacked>`: the unpacked release holds the program.
		program := filepath.Join(args[3], tnProgram)
		_ = os.MkdirAll(filepath.Dir(program), 0o755)
		_ = os.WriteFile(program, []byte("x"), 0o755)
		return run.Result{}
	}
	finder := &tnFinder{deps: deps, release: release, now: time.Now}
	finder.find()
	waitUntil(t, func() bool { return finder.find() != "" })
	if got := finder.find(); got != tnInstalledProgram(deps.MajhiHome) {
		t.Fatalf("%q", got)
	}
}
