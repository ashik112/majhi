package git

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"majhi/host/internal/protocol"
)

// How the helper's git authenticates with a workspace's own credential (GitAuth), on any
// platform: plain git and a small POSIX askpass script, never a system credential helper.
//
// Token handling. The token reaches git through majhi's askpass and a file, never argv or the
// environment:
//   - The askpass script lives in the helper's own folder (`<MAJHI_HOME>/host`, mode 700) and is
//     written once per start. It prints MAJHI_GIT_USERNAME for a username prompt and the contents
//     of the file named by MAJHI_ASKPASS_FILE for a password prompt.
//   - For each job the helper makes a fresh folder (mode 700) under that folder, writes the token to
//     a file in it (mode 600), and removes the folder when git exits, whatever happened.
//   - git's child processes see the file's path, not the token. `ps` and `/proc/<pid>/environ` show
//     no token. Only processes of the same user can read the file, for the seconds the job runs.
//   - `-c credential.helper=` empties the helper list, so osxkeychain, libsecret or wincred is
//     neither asked nor told to store anything; GIT_TERMINAL_PROMPT=0 stops every prompt.

// AskpassScript is majhi's askpass: it answers git's prompts for one job.
const AskpassScript = `#!/bin/sh
# majhi askpass: answers git's prompts for one job. Written by majhi's host helper.
case "$1" in
  Username*|username*) printf '%s\n' "$MAJHI_GIT_USERNAME" ;;
  *) [ -n "$MAJHI_ASKPASS_FILE" ] && cat "$MAJHI_ASKPASS_FILE" ;;
esac
`

// HelperDir is `<MAJHI_HOME>/host`, the helper's private folder.
func HelperDir(majhiHome string) string { return filepath.Join(majhiHome, "host") }

// EnsureAskpass writes the askpass script into the helper's private folder (mode 700) and returns its path.
func EnsureAskpass(majhiHome string) (string, error) {
	dir := HelperDir(majhiHome)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("make %s: %w", dir, err)
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return "", fmt.Errorf("protect %s: %w", dir, err)
	}
	file := filepath.Join(dir, "askpass.sh")
	if err := os.WriteFile(file, []byte(AskpassScript), 0o700); err != nil {
		return "", fmt.Errorf("write %s: %w", file, err)
	}
	if err := os.Chmod(file, 0o700); err != nil {
		return "", fmt.Errorf("protect %s: %w", file, err)
	}
	return file, nil
}

// AuthEnv is how to run git for one job.
type AuthEnv struct {
	// Env is the environment for the git child, with no token in it.
	Env map[string]string
	// Config are `-c` options that come before the git command.
	Config []string
	// Cleanup removes the job's token file. Safe to call twice.
	Cleanup func()
}

// AuthDeps are what an auth environment needs.
type AuthDeps struct {
	MajhiHome string
	// Askpass is the script from EnsureAskpass.
	Askpass string
	Path    string
	Home    string
	// SSHAuthSock is the ssh agent socket, for `ssh` auth.
	SSHAuthSock string
}

// BuildAuthEnv is the environment and `-c` options to run git with for one job. Only PATH, HOME,
// what the auth needs and the guards that keep a repo from running commands (guard.go): the
// helper's own environment is not passed on.
func BuildAuthEnv(deps AuthDeps, auth protocol.GitAuth) (AuthEnv, error) {
	env := map[string]string{
		"PATH":                deps.Path,
		"HOME":                deps.Home,
		"GIT_TERMINAL_PROMPT": "0",
		"GCM_INTERACTIVE":     "never",
		"LC_ALL":              "C",
	}
	for k, v := range GuardEnv() {
		env[k] = v
	}
	config := append(append([]string{}, GuardConfig...), "-c", "credential.helper=", "-c", "core.askPass=")
	nothing := func() {}
	switch auth.Kind {
	case protocol.AuthSSH:
		if deps.SSHAuthSock != "" {
			env["SSH_AUTH_SOCK"] = deps.SSHAuthSock
		}
		return AuthEnv{env, config, nothing}, nil
	case protocol.AuthToken:
	default:
		return AuthEnv{env, config, nothing}, nil
	}
	parent := HelperDir(deps.MajhiHome)
	if err := os.MkdirAll(parent, 0o700); err != nil {
		return AuthEnv{}, fmt.Errorf("make %s: %w", parent, err)
	}
	dir, err := os.MkdirTemp(parent, "job-")
	if err != nil {
		return AuthEnv{}, fmt.Errorf("make a folder for the job: %w", err)
	}
	var once sync.Once
	cleanup := func() { once.Do(func() { _ = os.RemoveAll(dir) }) }
	if err := os.Chmod(dir, 0o700); err != nil {
		cleanup()
		return AuthEnv{}, fmt.Errorf("protect the job folder: %w", err)
	}
	file := filepath.Join(dir, "password")
	if err := os.WriteFile(file, []byte(auth.Password), 0o600); err != nil {
		cleanup()
		return AuthEnv{}, fmt.Errorf("write the job's credential file: %w", err)
	}
	if err := os.Chmod(file, 0o600); err != nil {
		cleanup()
		return AuthEnv{}, fmt.Errorf("protect the job's credential file: %w", err)
	}
	env["GIT_ASKPASS"] = deps.Askpass
	env["MAJHI_ASKPASS_FILE"] = file
	env["MAJHI_GIT_USERNAME"] = auth.Username
	return AuthEnv{env, config, cleanup}, nil
}
