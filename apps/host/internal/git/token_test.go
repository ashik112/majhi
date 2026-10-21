package git

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"majhi/host/internal/protocol"
	"majhi/host/internal/run"
)

const secret = "ghp_HostSideSecretToken123456"

func realGit(t *testing.T, cwd string, args ...string) string {
	t.Helper()
	res := run.Exec("git", append([]string{"-c", "user.name=T", "-c", "user.email=t@acme.test"}, args...), run.Options{
		Env: map[string]string{
			"PATH": os.Getenv("PATH"), "HOME": t.TempDir(), "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1",
		},
		Cwd: cwd, Timeout: time.Minute,
	})
	if res.Code != 0 {
		t.Fatalf("git %v: %s", args, res.Stderr)
	}
	return strings.TrimSpace(res.Stdout)
}

func helperFiles(t *testing.T, majhiHome string) []string {
	t.Helper()
	entries, err := os.ReadDir(HelperDir(majhiHome))
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	sort.Strings(names)
	return names
}

// A git token reaches git through a private file only: never argv, the environment, a URL or an
// error, and the job's folder is gone when git exits (guarantee 4).
func TestCloneKeepsTheTokenOutOfArgvEnvAndErrors(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "src")
	if err := os.Mkdir(source, 0o755); err != nil {
		t.Fatal(err)
	}
	realGit(t, source, "init", "--quiet", "--initial-branch=trunk")
	if err := os.WriteFile(filepath.Join(source, "README.md"), []byte("# demo\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	realGit(t, source, "add", ".")
	realGit(t, source, "commit", "--quiet", "-m", "first")
	bare := filepath.Join(dir, "demo.git")
	realGit(t, dir, "clone", "--quiet", "--bare", source, bare)

	majhiHome := filepath.Join(dir, ".majhi")
	askpass, err := EnsureAskpass(majhiHome)
	if err != nil {
		t.Fatal(err)
	}
	var seenArgs []string
	var seenEnv map[string]string
	tokenFile, tokenInFile := "", ""
	spy := func(args []string, o StreamOptions) (int, string) {
		seenArgs, seenEnv = args, o.Env
		tokenFile = o.Env["MAJHI_ASKPASS_FILE"]
		data, _ := os.ReadFile(tokenFile)
		tokenInFile = string(data)
		return StreamingGit(args, o)
	}
	deps := CloneDeps{
		AuthDeps: AuthDeps{MajhiHome: majhiHome, Askpass: askpass, Path: os.Getenv("PATH"), Home: dir},
		Run:      run.Exec,
		Socket:   func() string { return "" },
		SpawnGit: spy,
	}
	auth := protocol.GitAuth{Kind: protocol.AuthToken, Username: "x-access-token", Password: secret}
	target := filepath.Join(dir, "Work", "acme", "demo")
	var progress []protocol.CloneProgress
	out, err := Clone(deps, protocol.GitCloneParams{Clone: "cl_AAAAAAAAAAAAAAAA", URL: bare, Path: target, Auth: auth},
		func(p protocol.CloneProgress) { progress = append(progress, p) })
	if err != nil {
		t.Fatal(err)
	}
	if out.Branch != "trunk" {
		t.Fatalf("branch %q", out.Branch)
	}
	if data, _ := os.ReadFile(filepath.Join(target, "README.md")); string(data) != "# demo\n" {
		t.Fatalf("clone content %q", data)
	}
	if tokenInFile != secret {
		t.Fatal("git did not get the token through the askpass file")
	}
	if strings.Contains(strings.Join(seenArgs, " "), secret) {
		t.Fatal("the token is in git's arguments")
	}
	for name, value := range seenEnv {
		if strings.Contains(value, secret) || strings.Contains(name, secret) {
			t.Fatalf("the token is in the environment (%s)", name)
		}
	}
	for _, want := range []string{"credential.helper=", "core.askPass=", "core.hooksPath=/dev/null"} {
		if !strings.Contains(strings.Join(seenArgs, " "), want) {
			t.Fatalf("git ran without -c %s", want)
		}
	}
	if seenEnv["GIT_TERMINAL_PROMPT"] != "0" {
		t.Fatal("git may prompt")
	}
	if _, err := os.Stat(tokenFile); !os.IsNotExist(err) {
		t.Fatal("the token file is still there")
	}
	if names := helperFiles(t, majhiHome); len(names) != 1 || names[0] != "askpass.sh" {
		t.Fatalf("the helper's folder holds %v", names)
	}
	if len(progress) == 0 || progress[0].Phase != protocol.PhaseConnecting {
		t.Fatalf("progress %v", progress)
	}
	if _, err := os.Stat(CloneTempPath(target, "cl_AAAAAAAAAAAAAAAA")); !os.IsNotExist(err) {
		t.Fatal("the temporary clone is still there")
	}

	// A failing clone says why in a fixed sentence, without the token or git's words.
	_, err = Clone(deps, protocol.GitCloneParams{Clone: "cl_BBBBBBBBBBBBBBBB", URL: filepath.Join(dir, "missing.git"), Path: filepath.Join(dir, "other"), Auth: auth},
		func(protocol.CloneProgress) {})
	if err == nil || strings.Contains(err.Error(), secret) {
		t.Fatalf("error %v", err)
	}
	if names := helperFiles(t, majhiHome); len(names) != 1 {
		t.Fatalf("a failed job left %v in the helper's folder", names)
	}
}

// A push with a workspace token does the same, and its argv and environment never hold the token.
func TestPushKeepsTheTokenOutOfArgvAndEnv(t *testing.T) {
	dir := t.TempDir()
	majhiHome := filepath.Join(dir, ".majhi")
	askpass, err := EnsureAskpass(majhiHome)
	if err != nil {
		t.Fatal(err)
	}
	authDeps := AuthDeps{MajhiHome: majhiHome, Askpass: askpass, Path: os.Getenv("PATH"), Home: dir}
	var calls []struct {
		args []string
		env  map[string]string
	}
	tokenFileInPush := ""
	fake := func(file string, args []string, o run.Options) run.Result {
		calls = append(calls, struct {
			args []string
			env  map[string]string
		}{args, o.Env})
		for _, a := range args {
			if a == "push" {
				data, _ := os.ReadFile(o.Env["MAJHI_ASKPASS_FILE"])
				tokenFileInPush = string(data)
			}
		}
		return run.Result{Code: 0}
	}
	deps := PushDeps{
		Run: fake, Home: dir, Path: os.Getenv("PATH"),
		Kind:    func(string) string { return "directory" },
		AuthEnv: func(a protocol.GitAuth) (AuthEnv, error) { return BuildAuthEnv(authDeps, a) },
	}
	err = Push(deps, protocol.GitPushParams{
		Path: dir, URL: "https://x-access-token@github.com/acme/api.git", Branch: "main",
		Auth: &protocol.GitAuth{Kind: protocol.AuthToken, Username: "x-access-token", Password: secret},
	})
	if err != nil {
		t.Fatal(err)
	}
	if tokenFileInPush != secret {
		t.Fatal("the push did not get the token through the askpass file")
	}
	for _, c := range calls {
		if strings.Contains(strings.Join(c.args, " "), secret) {
			t.Fatalf("the token is in argv: %v", c.args)
		}
		for name, value := range c.env {
			if strings.Contains(value, secret) {
				t.Fatalf("the token is in the environment (%s)", name)
			}
		}
		if strings.Contains(strings.Join(c.args, " "), "x-access-token@") {
			t.Fatalf("a user name is in the URL: %v", c.args)
		}
	}
	if names := helperFiles(t, majhiHome); len(names) != 1 || names[0] != "askpass.sh" {
		t.Fatalf("the helper's folder holds %v", names)
	}
}
