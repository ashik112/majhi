package git

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"majhi/host/internal/protocol"
	"majhi/host/internal/run"
)

// Clone and ls-remote with a workspace's own credential, on the owner's computer. git runs with
// majhi's askpass (see auth.go), never prompts, and never asks a system credential helper.
// Errors are fixed sentences: git's raw output never leaves this file.

const (
	cloneTimeout    = 60 * time.Minute
	lsRemoteTimeout = 50 * time.Second
	maxStderr       = 64 * 1024
)

// CloneDeps are what a clone needs.
type CloneDeps struct {
	AuthDeps
	Run run.Func
	// Socket is the ssh agent socket, looked up when an ssh job runs.
	Socket func() string
	// SpawnGit replaces the streaming spawn, for tests.
	SpawnGit StreamingRun
}

// StreamingRun runs git, handing each stderr line (split on `\r` and `\n`) to onLine. It never fails.
type StreamingRun func(args []string, o StreamOptions) (code int, stderr string)

// StreamOptions say how StreamingRun runs git.
type StreamOptions struct {
	Env     map[string]string
	Cwd     string
	Timeout time.Duration
	OnLine  func(line string)
}

// StreamingGit is the real StreamingRun.
func StreamingGit(args []string, o StreamOptions) (int, string) {
	var mu sync.Mutex
	var stderr []byte
	partial := ""
	proc := run.Spawn(run.SpawnOptions{
		File: "git",
		Args: args,
		Env:  o.Env,
		Cwd:  o.Cwd,
		OnStderr: func(chunk []byte) {
			mu.Lock()
			defer mu.Unlock()
			if len(stderr) < maxStderr {
				stderr = append(stderr, chunk...)
			}
			text := partial + string(chunk)
			start := 0
			for i := 0; i < len(text); i++ {
				if text[i] != '\r' && text[i] != '\n' {
					continue
				}
				if line := text[start:i]; strings.TrimSpace(line) != "" {
					o.OnLine(line)
				}
				start = i + 1
			}
			partial = text[start:]
		},
	})
	timedOut := false
	select {
	case <-proc.Done():
	case <-time.After(o.Timeout):
		timedOut = true
		proc.Kill()
		select {
		case <-proc.Done():
		case <-time.After(2 * time.Second):
		}
	}
	code := run.NoCode
	if !timedOut {
		code = proc.Wait()
	}
	mu.Lock()
	defer mu.Unlock()
	if partial != "" {
		o.OnLine(partial)
	}
	return code, strings.ToValidUTF8(string(stderr), "�")
}

// phaseOf is the clone phase one line of `git clone --progress` names, and the prefix text it starts with.
func phaseOf(text string) string {
	lower := strings.ToLower(text)
	lower = strings.TrimPrefix(lower, "remote: ")
	switch {
	case strings.HasPrefix(lower, "enumerating objects:"), strings.HasPrefix(lower, "counting objects:"):
		return protocol.PhaseCounting
	case strings.HasPrefix(lower, "compressing objects:"):
		return protocol.PhaseCompressing
	case strings.HasPrefix(lower, "receiving objects:"):
		return protocol.PhaseReceiving
	case strings.HasPrefix(lower, "resolving deltas:"):
		return protocol.PhaseResolving
	case strings.HasPrefix(lower, "updating files:"), strings.HasPrefix(lower, "checking out files:"):
		return protocol.PhaseCheckout
	}
	return ""
}

// percentOf is the first `: NN%` of a line: a colon, spaces, one to three digits and a percent sign.
func percentOf(text string) (int, bool) {
	for i := 0; i < len(text); i++ {
		if text[i] != ':' {
			continue
		}
		j := i + 1
		for j < len(text) && (text[j] == ' ' || text[j] == '\t') {
			j++
		}
		if j == i+1 {
			continue
		}
		k := j
		for k < len(text) && k-j < 3 && text[k] >= '0' && text[k] <= '9' {
			k++
		}
		if k > j && k < len(text) && text[k] == '%' {
			n, _ := strconv.Atoi(text[j:k])
			return min(n, 100), true
		}
	}
	return 0, false
}

// ParseProgress is the phase and percent of one line of `git clone --progress`, or false for any other line.
func ParseProgress(line string) (protocol.CloneProgress, bool) {
	text := strings.TrimSpace(line)
	phase := phaseOf(text)
	if phase == "" {
		return protocol.CloneProgress{}, false
	}
	progress := protocol.CloneProgress{Phase: phase}
	if pct, ok := percentOf(text); ok {
		progress.Percent = &pct
	}
	return progress, true
}

// FailureReason is a plain sentence for a failed git network command. Never git's output, never a URL with credentials.
func FailureReason(stderr, remote string, code int) string {
	lower := strings.ToLower(StripCredentials(stderr))
	switch {
	case code == run.NoCode:
		return "git did not finish in time on this computer."
	case containsAny(lower, "authentication failed", "could not read username", "could not read password",
		"terminal prompts disabled", "invalid credentials", "returned error: 401", "returned error: 403",
		"http 401", "http 403", "bad credentials", "access denied"):
		return "The git host refused the workspace's credential. Sign the workspace in again."
	case containsAny(lower, "permission denied (publickey", "host key verification failed"):
		return "No SSH key on this computer could log in for this repo. Check the workspace's SSH route."
	case containsAny(lower, "not found", "does not exist", "does not appear to be a git repository", "returned error: 404"):
		return "The repo was not found, or the workspace's account cannot see it."
	case containsAny(lower, "could not resolve host", "failed to connect", "connection timed out",
		"connection refused", "network is unreachable"):
		return "This computer could not reach " + hostOfRemote(remote) + "."
	}
	return "git could not reach the repo."
}

type pathStateKind int

const (
	pathMissing pathStateKind = iota
	pathEmpty
	pathTaken
)

func pathState(path string) pathStateKind {
	info, err := os.Stat(path)
	if err != nil {
		return pathMissing
	}
	if !info.IsDir() {
		return pathTaken
	}
	entries, err := os.ReadDir(path)
	if err != nil || len(entries) > 0 {
		return pathTaken
	}
	return pathEmpty
}

func (d CloneDeps) authEnv(auth protocol.GitAuth) (AuthEnv, error) {
	deps := d.AuthDeps
	if auth.Kind == protocol.AuthSSH && d.Socket != nil {
		deps.SSHAuthSock = d.Socket()
	}
	return BuildAuthEnv(deps, auth)
}

func badRemote(remote string) bool {
	return strings.HasPrefix(remote, "-") || strings.ContainsAny(remote, " \t\n\r\f\v\x00")
}

// CloneTempPath is the temporary sibling folder a clone is made in. The server and the helper both use it:
// the helper clones there, the server removes it after a clone a restart cut off.
func CloneTempPath(path, clone string) string {
	trimmed := strings.TrimRight(path, "/")
	cut := strings.LastIndex(trimmed, "/")
	return trimmed[:cut] + "/." + trimmed[cut+1:] + ".majhi-clone-" + clone
}

// Clone is `git clone --progress` into a temporary sibling of path, renamed to path when done. The
// temporary folder is removed whatever happens. It refuses a path that exists and is not empty.
func Clone(deps CloneDeps, params protocol.GitCloneParams, progress func(protocol.CloneProgress)) (protocol.CloneResult, error) {
	if !filepath.IsAbs(params.Path) || strings.Contains(params.Path, "\x00") {
		return protocol.CloneResult{}, errors.New("The path must be absolute.")
	}
	if badRemote(params.URL) {
		return protocol.CloneResult{}, errors.New("That is not a git remote URL.")
	}
	if params.Branch != "" && (!protocol.IsPlainBranch(params.Branch) || strings.Contains(params.Branch, "..")) {
		return protocol.CloneResult{}, errors.New("That is not a plain branch name.")
	}
	if pathState(params.Path) == pathTaken {
		return protocol.CloneResult{}, fmt.Errorf("%s already exists and is not empty.", params.Path)
	}
	parent := filepath.Dir(params.Path)
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return protocol.CloneResult{}, fmt.Errorf("Cannot make %s: %v", parent, err)
	}
	temp := CloneTempPath(params.Path, params.Clone)
	_ = os.RemoveAll(temp)
	auth, err := deps.authEnv(params.Auth)
	if err != nil {
		return protocol.CloneResult{}, err
	}
	defer func() {
		auth.Cleanup()
		_ = os.RemoveAll(temp)
	}()
	spawn := deps.SpawnGit
	if spawn == nil {
		spawn = StreamingGit
	}
	progress(protocol.CloneProgress{Phase: protocol.PhaseConnecting})
	args := append([]string{}, auth.Config...)
	args = append(args, "clone", "--progress")
	if params.Branch != "" {
		args = append(args, "--branch", params.Branch)
	}
	args = append(args, "--", params.URL, temp)
	code, stderr := spawn(args, StreamOptions{
		Env: auth.Env, Cwd: parent, Timeout: cloneTimeout,
		OnLine: func(line string) {
			if found, ok := ParseProgress(line); ok {
				progress(found)
			}
		},
	})
	if code != 0 {
		return protocol.CloneResult{}, errors.New(FailureReason(stderr, params.URL, code))
	}
	plain := run.Options{Env: map[string]string{"PATH": deps.Path, "HOME": deps.Home, "LC_ALL": "C"}, Timeout: 20 * time.Second}
	head := deps.Run("git", []string{"-C", temp, "rev-parse", "--verify", "--quiet", "HEAD"}, plain)
	commit := strings.TrimSpace(head.Stdout)
	if head.Code != 0 || !protocol.IsCommit(commit) {
		return protocol.CloneResult{}, errors.New("The repo is empty, so there is nothing to clone. Use New project, then connect it to this repo.")
	}
	branch := deps.Run("git", []string{"-C", temp, "symbolic-ref", "--short", "HEAD"}, plain)
	name := strings.TrimSpace(branch.Stdout)
	if branch.Code != 0 || name == "" {
		return protocol.CloneResult{}, errors.New("The clone has no branch checked out.")
	}
	if pathState(params.Path) == pathTaken {
		return protocol.CloneResult{}, fmt.Errorf("%s filled up while the clone ran. Nothing was changed there.", params.Path)
	}
	if err := os.Rename(temp, params.Path); err != nil {
		return protocol.CloneResult{}, fmt.Errorf("Cannot move the clone into place: %v", err)
	}
	pct := 100
	progress(protocol.CloneProgress{Phase: protocol.PhaseCheckout, Percent: &pct})
	return protocol.CloneResult{Head: commit, Branch: name}, nil
}

// LsRemote is `git ls-remote --symref`: whether the remote is reachable, empty, and where its HEAD points.
func LsRemote(deps CloneDeps, params protocol.GitLsRemoteParams) (protocol.LsRemoteResult, error) {
	if badRemote(params.URL) {
		return protocol.LsRemoteResult{}, errors.New("That is not a git remote URL.")
	}
	auth, err := deps.authEnv(params.Auth)
	if err != nil {
		return protocol.LsRemoteResult{}, err
	}
	defer auth.Cleanup()
	args := append(append([]string{}, auth.Config...), "ls-remote", UploadPack, "--symref", "--", params.URL)
	result := deps.Run("git", args, run.Options{
		Env: auth.Env,
		// Not in the helper's folder: ls-remote reads the repo config of where it runs, and that may be a broken checkout.
		Cwd:     deps.MajhiHome,
		Timeout: lsRemoteTimeout,
	})
	if result.Code != 0 {
		return protocol.LsRemoteResult{}, errors.New(FailureReason(result.Stderr, params.URL, result.Code))
	}
	out := protocol.LsRemoteResult{Empty: true}
	for _, line := range strings.Split(result.Stdout, "\n") {
		if strings.Contains(line, "\trefs/heads/") {
			out.Empty = false
		}
		if branch, ok := symrefHead(line); ok && out.DefaultBranch == "" {
			out.DefaultBranch = branch
		}
	}
	return out, nil
}

// symrefHead reads `ref: refs/heads/<branch>\tHEAD`.
func symrefHead(line string) (string, bool) {
	rest, ok := strings.CutPrefix(strings.TrimRight(line, "\r"), "ref: refs/heads/")
	if !ok {
		return "", false
	}
	branch, tail, ok := strings.Cut(rest, "\t")
	if !ok || strings.TrimSpace(tail) != "HEAD" || branch == "" || strings.ContainsAny(branch, " \t") {
		return "", false
	}
	return branch, true
}
