package git

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"majhi/host/internal/protocol"
	"majhi/host/internal/run"
)

func pushSetup(t *testing.T) (dir, repo string, deps PushDeps, authCalls *int) {
	t.Helper()
	dir = t.TempDir()
	repo = filepath.Join(dir, "repo")
	if err := os.Mkdir(repo, 0o755); err != nil {
		t.Fatal(err)
	}
	realGit(t, repo, "init", "--quiet", "--initial-branch=main")
	majhiHome := filepath.Join(dir, ".majhi")
	askpass, err := PrepareHelperDir(majhiHome)
	if err != nil {
		t.Fatal(err)
	}
	authDeps := AuthDeps{MajhiHome: majhiHome, Askpass: askpass, Path: os.Getenv("PATH"), Home: dir}
	calls := 0
	deps = PushDeps{
		Run: func(file string, args []string, o run.Options) run.Result {
			// Reading the repo's config is real; a push would only be faked.
			for _, a := range args {
				if a == "push" {
					return run.Result{}
				}
			}
			o.Env = map[string]string{"PATH": os.Getenv("PATH"), "HOME": dir, "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1"}
			return run.Exec(file, args, o)
		},
		Home: dir, Path: os.Getenv("PATH"),
		Kind: func(string) string { return "directory" },
		AuthEnv: func(a protocol.GitAuth) (AuthEnv, error) {
			calls++
			return BuildAuthEnv(authDeps, a)
		},
	}
	return dir, repo, deps, &calls
}

func pushParams(repo string) protocol.GitPushParams {
	return protocol.GitPushParams{
		Path: repo, URL: "https://github.com/acme/api.git", Branch: "main",
		Auth: &protocol.GitAuth{Kind: protocol.AuthToken, Username: "x-access-token", Password: secret},
	}
}

// A repo whose own config sets a proxy, a certificate check or an extra header is not pushed from
// this computer: a proxy would read the login or token the push carries. The token file is never written.
func TestPushRefusesNetworkSettingsOfTheRepo(t *testing.T) {
	cases := []struct{ key, value string }{
		{"http.proxy", "http://evil.test:3128"},
		{"http.https://github.com/.proxy", "http://evil.test:3128"},
		{"http.sslVerify", "false"},
		{"http.extraHeader", "X-Steal: 1"},
		{"http.sslCAInfo", "/tmp/evil.pem"},
		{"remote.origin.proxy", "http://evil.test:3128"},
		{"remote.origin.pushurl", "https://evil.test/x.git"},
		{"remote.origin.receivepack", "/tmp/evil"},
		{"push.recurseSubmodules", "on-demand"},
	}
	for _, c := range cases {
		t.Run(c.key, func(t *testing.T) {
			dir, repo, deps, authCalls := pushSetup(t)
			realGit(t, repo, "config", c.key, c.value)
			err := Push(deps, pushParams(repo))
			if err == nil || !strings.Contains(err.Error(), "does not push through network settings a repo sets") ||
				!strings.Contains(err.Error(), strings.ToLower(c.key[:strings.Index(c.key, ".")])) {
				t.Fatalf("the push was not refused for %s: %v", c.key, err)
			}
			if strings.Contains(err.Error(), secret) {
				t.Fatal("the token is in the error")
			}
			if *authCalls != 0 {
				t.Fatal("a token file was written for a push that was refused")
			}
			if entries, _ := os.ReadDir(HelperDir(filepath.Join(dir, ".majhi"))); len(entries) != 1 {
				t.Fatalf("the helper's folder holds %v", entries)
			}
		})
	}
	// `push.recurseSubmodules=no` is the safe value, and a plain repo pushes.
	_, repo, deps, _ := pushSetup(t)
	realGit(t, repo, "config", "push.recurseSubmodules", "no")
	if err := Push(deps, pushParams(repo)); err != nil {
		t.Fatal(err)
	}
}

// The token's folder is removed when the push stops with a panic, and a folder a stopped helper left
// is removed when the helper starts.
func TestTokenFolderDoesNotOutliveACrash(t *testing.T) {
	dir, repo, deps, _ := pushSetup(t)
	majhiHome := filepath.Join(dir, ".majhi")
	inner := deps.Run
	deps.Run = func(file string, args []string, o run.Options) run.Result {
		for _, a := range args {
			if a == "push" {
				if data, _ := os.ReadFile(o.Env["MAJHI_ASKPASS_FILE"]); string(data) != secret {
					t.Error("the token was not in its file during the push")
				}
				panic("the push crashed")
			}
		}
		return inner(file, args, o)
	}
	func() {
		defer func() { _ = recover() }()
		_ = Push(deps, pushParams(repo))
	}()
	entries, _ := os.ReadDir(HelperDir(majhiHome))
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "job-") {
			t.Fatalf("%s was left after a crash", e.Name())
		}
	}

	// A helper killed in the middle of a job leaves its folder; the next start clears it.
	stale := filepath.Join(HelperDir(majhiHome), "job-leftover")
	if err := os.MkdirAll(stale, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stale, "password"), []byte(secret), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := PrepareHelperDir(majhiHome); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatal("a stale token folder survived the start")
	}
	if _, err := os.Stat(filepath.Join(HelperDir(majhiHome), "askpass.sh")); err != nil {
		t.Fatal("the askpass script is gone")
	}
}
