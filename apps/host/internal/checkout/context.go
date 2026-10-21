// Package checkout is the majhi checkout the helper runs `docker compose` in: its git state, its
// release package files, and the release an update moves to.
package checkout

import (
	"errors"
	"strings"
	"sync"
	"time"

	"majhi/host/internal/git"
	"majhi/host/internal/protocol"
	"majhi/host/internal/run"
)

const gitTimeout = 10 * time.Second

// RepoState is what the helper knows of the checkout.
type RepoState struct {
	// Commit is the checkout's HEAD.
	Commit string
	// Dirty is true when the checkout has uncommitted changes.
	Dirty bool
}

// Context runs git in the majhi checkout.
type Context struct {
	Git  string
	Repo string
	Env  map[string]string
	Run  run.Func
}

// Guarded runs git in the majhi checkout with the helper's guards (git/guard.go). Its `.git/config`
// is shared with every task worktree of majhi, so an agent outside a container can plant a command
// there. readsFiles: the command reads the work tree's files, so the filter drivers that config
// names are turned off too.
func (c Context) Guarded(args []string, readsFiles bool, timeout time.Duration) (string, error) {
	if timeout <= 0 {
		timeout = gitTimeout
	}
	env := mergeEnv(c.Env, git.GuardEnv())
	if readsFiles {
		listed := ""
		if res := c.Run(c.Git, append(append([]string{}, git.GuardConfig...), git.ListFilters...), run.Options{Env: env, Cwd: c.Repo, Timeout: timeout}); res.Code == 0 {
			listed = res.Stdout
		}
		env = git.WithConfig(env, git.FiltersOff(listed))
	}
	res := c.Run(c.Git, append(append([]string{}, git.GuardConfig...), args...), run.Options{Env: env, Cwd: c.Repo, Timeout: timeout, MaxOutput: 1 << 20})
	if res.Code != 0 {
		return "", errors.New("git " + firstWord(args) + " failed")
	}
	return res.Stdout, nil
}

func firstWord(args []string) string {
	if len(args) == 0 {
		return ""
	}
	return args[0]
}

func mergeEnv(base, extra map[string]string) map[string]string {
	out := make(map[string]string, len(base)+len(extra))
	for k, v := range base {
		out[k] = v
	}
	for k, v := range extra {
		out[k] = v
	}
	return out
}

// ReadRepo is HEAD and dirtiness of the majhi checkout. False when git fails or the folder is not a checkout.
func ReadRepo(c Context) (RepoState, bool) {
	packaged, err := ReadPackage(c.Repo)
	if err == nil && packaged != nil {
		return RepoState{Commit: packaged.Commit}, true
	}
	if err != nil {
		return RepoState{}, false
	}
	head, err := c.Guarded([]string{"rev-parse", "HEAD"}, false, 0)
	head = strings.TrimSpace(head)
	if err != nil || !protocol.IsCommit(head) {
		return RepoState{}, false
	}
	// A submodule's own config could name filters too; majhi has none.
	status, err := c.Guarded([]string{"status", "--porcelain", "--ignore-submodules=all"}, true, 0)
	if err != nil {
		return RepoState{}, false
	}
	return RepoState{Commit: head, Dirty: strings.TrimSpace(status) != ""}, true
}

// CommitSubjects are the subjects of the commits after from up to to (HEAD, or the release an
// update moves to), newest first, at most 20. Empty when from is not in this checkout.
func CommitSubjects(c Context, from, to string) []string {
	if to == "" {
		to = "HEAD"
	}
	if pkg, err := ReadPackage(c.Repo); err != nil || pkg != nil {
		return []string{}
	}
	if !protocol.IsCommit(from) || (to != "HEAD" && !protocol.IsCommit(to)) {
		return []string{}
	}
	// No signature check either: a planted `log.showSignature` would run the repo's `gpg.program`.
	out, err := c.Guarded([]string{"log", "--no-ext-diff", "--no-textconv", "--no-show-signature", "--format=%s", from + ".." + to, "-n", "20"}, false, 0)
	if err != nil {
		return []string{}
	}
	subjects := []string{}
	for _, line := range strings.Split(out, "\n") {
		if line = strings.TrimSpace(line); line != "" {
			subjects = append(subjects, line)
		}
	}
	if len(subjects) > 20 {
		subjects = subjects[:20]
	}
	return subjects
}

// Facts keeps the checkout state and Docker runtime fresh in memory, because the poll header needs them at once.
type Facts struct {
	// Target reads what an update would run (release.go). Nil without a checkout.
	Target func() (RepoState, bool)
	// Docker is the docker CLI, read at each refresh: on WSL2 it can appear after the helper started.
	Docker func() string
	Env    map[string]string
	Run    run.Func

	mu      sync.Mutex
	state   *RepoState
	runtime string
}

// Refresh reads the checkout and Docker again.
func (f *Facts) Refresh() {
	if f.Target != nil {
		state, ok := f.Target()
		f.mu.Lock()
		if ok {
			f.state = &state
		} else {
			f.state = nil
		}
		f.mu.Unlock()
	}
	if docker := f.Docker(); docker != "" {
		res := f.Run(docker, []string{"info", "--format", "{{.OperatingSystem}}"}, run.Options{Env: f.Env, Cwd: "/", Timeout: gitTimeout})
		if res.Code == 0 {
			f.mu.Lock()
			f.runtime = ParseDockerRuntime(res.Stdout)
			f.mu.Unlock()
		}
		// Docker is not up: keep the last answer.
	}
}

// Repo is the last reading of the checkout.
func (f *Facts) Repo() (RepoState, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.state == nil {
		return RepoState{}, false
	}
	return *f.state, true
}

// Runtime is the docker runtime last seen, or "".
func (f *Facts) Runtime() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.runtime
}

// ParseDockerRuntime reads what `docker info --format {{.OperatingSystem}}` printed. OrbStack says
// "OrbStack", Docker Desktop "Docker Desktop".
func ParseDockerRuntime(operatingSystem string) string {
	text := strings.ToLower(operatingSystem)
	switch {
	case strings.Contains(text, "orbstack"):
		return protocol.RuntimeOrbStack
	case strings.Contains(text, "docker desktop"):
		return protocol.RuntimeDockerDesktop
	}
	return protocol.RuntimeDocker
}
