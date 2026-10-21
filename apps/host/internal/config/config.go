// Package config reads the helper's settings from environment variables.
package config

import (
	"errors"
	"net/url"
	"path/filepath"
	"strings"

	"majhi/host/internal/paths"
)

// DefaultVersion is the helper's version when MAJHI_HOST_VERSION names none. The build sets it.
var DefaultVersion = "0.0.0"

// Config is the helper's settings.
type Config struct {
	// URL is majhi's server, without a trailing slash.
	URL string
	// Home is the owner's home. `~` in paths expands against it.
	Home      string
	MajhiHome string
	// Repo is the majhi checkout `docker compose` runs in. Empty: remounting is manual.
	Repo    string
	Version string
	// Notify says whether notifications reach the desktop.
	Notify bool
}

// Parse reads the settings from env (empty values count as unset, as a plist or `.env` may hold).
// It fails with one line per bad variable.
func Parse(env map[string]string, home string) (Config, error) {
	get := func(name string) string { return strings.TrimSpace(env[name]) }
	var problems []string
	rawURL := get("MAJHI_URL")
	if rawURL == "" {
		rawURL = "http://127.0.0.1:7070"
	}
	if u, err := url.Parse(rawURL); err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		problems = append(problems, "MAJHI_URL: Use an http:// URL")
	}
	majhiHome := get("MAJHI_HOME")
	if majhiHome == "" {
		majhiHome = "~/.majhi"
	}
	majhiHome = paths.ExpandHome(majhiHome, home)
	repo := get("MAJHI_REPO")
	if repo != "" {
		repo = paths.ExpandHome(repo, home)
	}
	notify := get("MAJHI_HOST_NOTIFY")
	if notify != "" && notify != "on" && notify != "off" {
		problems = append(problems, "MAJHI_HOST_NOTIFY: Invalid option: expected one of \"on\"|\"off\"")
	}
	for _, p := range []struct{ name, path string }{{"MAJHI_HOME", majhiHome}, {"MAJHI_REPO", repo}} {
		if p.path != "" && !filepath.IsAbs(p.path) {
			problems = append(problems, p.name+": Use an absolute path, or one starting with ~/")
		}
	}
	if len(problems) > 0 {
		return Config{}, errors.New("Invalid environment:\n" + strings.Join(problems, "\n"))
	}
	version := get("MAJHI_HOST_VERSION")
	if version == "" {
		version = DefaultVersion
	}
	cfg := Config{
		URL:       strings.TrimRight(rawURL, "/"),
		Home:      home,
		MajhiHome: filepath.Clean(majhiHome),
		Version:   version,
		Notify:    notify != "off",
	}
	if repo != "" {
		cfg.Repo = filepath.Clean(repo)
	}
	return cfg, nil
}
