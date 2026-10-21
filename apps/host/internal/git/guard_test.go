package git

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"majhi/host/internal/run"
)

// A push never forces, never deletes and goes to an https URL only (guarantee: the push guard).
func TestPushRefusesForceDeleteAndNonHTTPS(t *testing.T) {
	good := "https://github.com/acme/api.git"
	cases := []struct{ name, url, branch string }{
		{"force with a plus", good, "+main"},
		{"delete with an empty source", good, ":main"},
		{"a colon in the name", good, "a:b"},
		{"a refspec", good, "main:other"},
		{"a parent path", good, "a..b"},
		{"a lock file", good, "main.lock"},
		{"a trailing slash", good, "main/"},
		{"starts with a dash", good, "-main"},
		{"ssh", "git@github.com:acme/api.git", "main"},
		{"ssh scheme", "ssh://git@github.com/acme/api.git", "main"},
		{"plain http", "http://github.com/acme/api.git", "main"},
		{"a local path", "/tmp/repo.git", "main"},
		{"a password in the URL", "https://user:pw@github.com/acme/api.git", "main"},
		{"the ext protocol", "ext::sh -c touch% /tmp/pwned", "main"},
		{"a space", "https://github.com/acme/api .git", "main"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if args, err := PushArgs(c.url, c.branch); err == nil {
				t.Fatalf("accepted %v", args)
			}
		})
	}
	args, err := PushArgs(good, "feat/a-b")
	if err != nil || strings.Join(args, " ") != "push --quiet "+good+" refs/heads/feat/a-b:refs/heads/feat/a-b" {
		t.Fatalf("%v %v", args, err)
	}
}

func scoped(entries ...[3]string) string {
	var out strings.Builder
	for _, e := range entries {
		out.WriteString(e[0] + "\x00" + e[1] + "\n" + e[2] + "\x00")
	}
	return out.String()
}

func guardedRun(listing string) run.Func {
	return func(string, []string, run.Options) run.Result { return run.Result{Code: 0, Stdout: listing} }
}

// settingsOf is the settings in the order git reads them, so the last of a key wins, as in git.
func settingsOf(env map[string]string) map[string]string {
	out := map[string]string{}
	n, _ := strconv.Atoi(env["GIT_CONFIG_COUNT"])
	for i := 0; i < n; i++ {
		out[env["GIT_CONFIG_KEY_"+strconv.Itoa(i)]] = env["GIT_CONFIG_VALUE_"+strconv.Itoa(i)]
	}
	return out
}

// The repo's own askpass, alternateRefsCommand, credential helpers and signing never run in a push.
func TestPushGuardIgnoresWhatTheRepoPlants(t *testing.T) {
	listing := scoped(
		[3]string{"global", "credential.helper", "osxkeychain"},
		[3]string{"local", "credential.helper", "!evil"},
		[3]string{"local", "core.askpass", "/tmp/steal"},
		[3]string{"local", "core.alternaterefscommand", "/tmp/run-me"},
		[3]string{"global", "core.askpass", "/usr/bin/owner-askpass"},
	)
	guard, err := PushGuard(guardedRun(listing), "/p", map[string]string{}, "https://github.com/acme/api.git", true)
	if err != nil {
		t.Fatal(err)
	}
	if guard.Env["GIT_ALLOW_PROTOCOL"] != "https" {
		t.Fatal("not https only")
	}
	got := settingsOf(guard.Env)
	if got["push.gpgSign"] != "false" {
		t.Fatal("push signing is on")
	}
	if got["core.askpass"] != "/usr/bin/owner-askpass" {
		t.Fatalf("askpass %q: the repo's replaced the owner's", got["core.askpass"])
	}
	if v, ok := got["core.alternaterefscommand"]; !ok || v != "" {
		t.Fatalf("alternateRefsCommand %q", v)
	}
	if v, ok := got["credential.helper"]; !ok {
		t.Fatal("the repo's credential helper was not dropped")
	} else if v != "osxkeychain" {
		// The list is emptied first, then the owner's put back in order.
		t.Fatalf("last helper %q", v)
	}
	if guard.Options[0] != "--receive-pack=git-receive-pack" {
		t.Fatalf("options %v", guard.Options)
	}
}

// A `url.<base>.insteadOf` in the repo cannot send the push (and its credential) to another host.
func TestPushGuardRefusesOrBeatsRewrites(t *testing.T) {
	const url = "https://github.com/acme/api.git"
	if _, err := PushGuard(guardedRun(scoped(
		[3]string{"local", "url.https://evil.test/.insteadof", "https://github.com/"},
		[3]string{"local", "url.https://evil.test/x.insteadof", url},
		[3]string{"local", "url.https://evil.test/y.pushinsteadof", url + "/"},
	)), "/p", map[string]string{}, url, true); err == nil {
		t.Fatal("a rewrite of the exact address, with its slashed twin, was not refused")
	}
	guard, err := PushGuard(guardedRun(scoped([3]string{"local", "url.https://evil.test/.insteadof", "https://github.com/"})),
		"/p", map[string]string{}, url, true)
	if err != nil {
		t.Fatal(err)
	}
	if got := settingsOf(guard.Env); got["url."+url+".insteadOf"] != url || got["url."+url+".pushInsteadOf"] != url {
		t.Fatalf("the address was not made its own rewrite: %v", got)
	}
	slashed, err := PushGuard(guardedRun(scoped([3]string{"local", "url.https://evil.test/.insteadof", url})),
		"/p", map[string]string{}, url, true)
	if err != nil || slashed.URL != url+"/" {
		t.Fatalf("%v %v", slashed.URL, err)
	}
}

// With real git: the repo's hooks, fsmonitor, filter drivers and rewrites do not run or apply.
func TestGuardsHoldAgainstARealRepo(t *testing.T) {
	dir := t.TempDir()
	repo := filepath.Join(dir, "repo")
	if err := os.Mkdir(repo, 0o755); err != nil {
		t.Fatal(err)
	}
	realGit(t, repo, "init", "--quiet", "--initial-branch=main")
	marker := filepath.Join(dir, "ran")
	script := "#!/bin/sh\ntouch " + marker + "\n"
	write := func(path, text string) {
		if err := os.WriteFile(path, []byte(text), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join(repo, ".git", "hooks", "pre-commit"), script)
	hook := filepath.Join(dir, "fsmonitor.sh")
	write(hook, script+"printf '\\0'\n")
	realGit(t, repo, "config", "core.fsmonitor", hook)
	driver := filepath.Join(dir, "filter.sh")
	write(driver, script+"cat\n")
	realGit(t, repo, "config", "filter.x.clean", driver)
	realGit(t, repo, "config", "filter.x.required", "true")
	realGit(t, repo, "config", "url.https://evil.test/.insteadOf", "https://github.com/")
	write(filepath.Join(repo, ".gitattributes"), "*.txt filter=x\n")
	write(filepath.Join(repo, "a.txt"), "hello\n")

	env := map[string]string{"PATH": os.Getenv("PATH"), "HOME": dir, "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1"}
	for k, v := range GuardEnv() {
		env[k] = v
	}
	listed := run.Exec("git", append(append([]string{"-C", repo}, GuardConfig...), ListFilters...), run.Options{Env: env, Timeout: time.Minute})
	filtered := WithConfig(env, FiltersOff(listed.Stdout))
	run1 := run.Exec("git", append(append([]string{"-C", repo, "-c", "user.name=T", "-c", "user.email=t@acme.test"}, GuardConfig...), "add", "a.txt"), run.Options{Env: filtered, Timeout: time.Minute})
	if run1.Code != 0 {
		t.Fatalf("add: %s", run1.Stderr)
	}
	commit := run.Exec("git", append(append([]string{"-C", repo, "-c", "user.name=T", "-c", "user.email=t@acme.test"}, GuardConfig...),
		"-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "x"), run.Options{Env: filtered, Timeout: time.Minute})
	if commit.Code != 0 {
		t.Fatalf("commit: %s", commit.Stderr)
	}
	if res := run.Exec("git", append(append([]string{"-C", repo}, GuardConfig...), "status", "--porcelain"), run.Options{Env: filtered, Timeout: time.Minute}); res.Code != 0 {
		t.Fatalf("status: %s", res.Stderr)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("a hook, fsmonitor or filter driver of the repo ran")
	}

	// The control: without the guards the repo's hook runs, so the check above means something.
	realGit(t, repo, "commit", "--quiet", "--allow-empty", "-m", "y")
	if _, err := os.Stat(marker); err != nil {
		t.Fatal("the planted hook does not run even unguarded, so this test proves nothing")
	}

	// The rewrite is read, then beaten: the push address stays the one asked for.
	url := "https://github.com/acme/api.git"
	guard, err := PushGuard(run.Exec, repo, env, url, true)
	if err != nil {
		t.Fatal(err)
	}
	pushEnv := map[string]string{}
	for k, v := range env {
		pushEnv[k] = v
	}
	for k, v := range guard.Env {
		pushEnv[k] = v
	}
	res := run.Exec("git", []string{"-C", repo, "ls-remote", "--get-url", guard.URL}, run.Options{Env: pushEnv, Timeout: time.Minute})
	if got := strings.TrimSpace(res.Stdout); got != url {
		t.Fatalf("the push address became %q", got)
	}
}
