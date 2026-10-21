// Package sys holds what every part of the helper that touches the machine needs: the program
// runner, the helper's environment, its folders and PATH, and the log. A test replaces Run and
// Find, so nothing real is touched.
package sys

import (
	"majhi/host/internal/download"
	"majhi/host/internal/hostlog"
	"majhi/host/internal/paths"
	"majhi/host/internal/run"
)

// Deps are the machine-facing parts of the helper.
type Deps struct {
	Run run.Func
	// Env is the helper's own environment. A program gets only the variables it needs from it.
	Env  map[string]string
	Home string
	// MajhiHome is `~/.majhi`, or MAJHI_HOME.
	MajhiHome string
	// Path is the helper's PATH with the OS's tool folders added.
	Path string
	// Find returns the absolute path of the first executable `name` on Path, or "".
	Find func(name string) string
	// Exists is true when something is at the path.
	Exists func(path string) bool
	Log    hostlog.Logger
	// Download fetches a pinned tool the helper installs itself (macOS: terminal-notifier).
	// Nil where nothing may be downloaded, as with MAJHI_HOST_NOTIFY=off.
	Download download.Func
}

// Real builds Deps over the real process.
func Real(env map[string]string, os, home, majhiHome string, log hostlog.Logger, downloads bool) Deps {
	path := paths.ToolPath(env["PATH"], os, home)
	deps := Deps{
		Run:       run.Exec,
		Env:       env,
		Home:      home,
		MajhiHome: majhiHome,
		Path:      path,
		Find:      func(name string) string { return paths.FindExecutable(name, path) },
		Exists:    paths.Exists,
		Log:       log,
	}
	if downloads {
		deps.Download = download.Bytes
	}
	return deps
}
