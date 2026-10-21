package platform

import (
	"crypto/sha256"
	"encoding/hex"
	"math"
	"os"
	"path/filepath"
	"sync"
	"time"

	"majhi/host/internal/sys"
)

// terminal-notifier, which majhi installs itself on macOS so a click on a notification opens majhi at
// the page (osascript's notifications come from Script Editor and a click opens Script Editor). The
// release is pinned by URL and SHA-256 (decision of 2026-10-04): nothing else is ever unpacked.

// NotifierRelease is a pinned terminal-notifier release.
type NotifierRelease struct {
	Version string
	URL     string
	// SHA256 is of the zip, lower-case hex.
	SHA256 string
}

// TerminalNotifier is the release the helper installs.
var TerminalNotifier = NotifierRelease{
	Version: "3.1.0",
	URL:     "https://github.com/julienXX/terminal-notifier/releases/download/3.1.0/terminal-notifier-3.1.0.zip",
	SHA256:  "e969d4ae20287da1ba55495ae31dcedd8e9069deb8ce4eed24f6561a5fc3e4d5",
}

const (
	dittoBin      = "/usr/bin/ditto"
	unpackTimeout = 30 * time.Second
	// installRetry: after a failed download, the next notification tries again only after this long.
	installRetry = 60 * time.Minute
)

// tnProgram is where the program sits inside the release zip, and inside the install folder.
var tnProgram = filepath.Join("terminal-notifier.app", "Contents", "MacOS", "terminal-notifier")

// tnInstallDir is `<MAJHI_HOME>/bin/terminal-notifier`, which holds terminal-notifier.app.
func tnInstallDir(majhiHome string) string {
	return filepath.Join(majhiHome, "bin", "terminal-notifier")
}

func tnInstalledProgram(majhiHome string) string {
	return filepath.Join(tnInstallDir(majhiHome), tnProgram)
}

type installResult int

const (
	installed installResult = iota
	installMismatch
	installFailed
)

// installTerminalNotifier downloads the pinned release, checks its SHA-256, unpacks it in a
// temporary folder next to the install folder and renames it into place, so a half-done install is
// never used.
func installTerminalNotifier(deps sys.Deps, release NotifierRelease) installResult {
	bytes, err := deps.Download(release.URL)
	if err != nil {
		deps.Log("notify: could not install terminal-notifier: " + err.Error())
		return installFailed
	}
	sum := sha256.Sum256(bytes)
	got := hex.EncodeToString(sum[:])
	if got != release.SHA256 {
		deps.Log("notify: the terminal-notifier " + release.Version + " download did not match its pinned SHA-256 (got " + got + "); it was discarded and no notification is shown")
		return installMismatch
	}
	bin := filepath.Join(deps.MajhiHome, "bin")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		deps.Log("notify: could not install terminal-notifier: " + err.Error())
		return installFailed
	}
	work, err := os.MkdirTemp(bin, ".terminal-notifier-")
	if err != nil {
		deps.Log("notify: could not install terminal-notifier: " + err.Error())
		return installFailed
	}
	defer os.RemoveAll(work)
	zip := filepath.Join(work, "release.zip")
	unpacked := filepath.Join(work, "unpacked")
	if err := os.WriteFile(zip, bytes, 0o600); err != nil {
		deps.Log("notify: could not install terminal-notifier: " + err.Error())
		return installFailed
	}
	done := deps.Run(dittoBin, []string{"-x", "-k", zip, unpacked}, runOptions(map[string]string{"PATH": "/usr/bin:/bin"}, unpackTimeout))
	if done.Code != 0 || !isFile(filepath.Join(unpacked, tnProgram)) {
		deps.Log("notify: could not unpack terminal-notifier; no notification is shown")
		return installFailed
	}
	target := tnInstallDir(deps.MajhiHome)
	// Only a broken install can be here: a working one is found before an install starts.
	if err := os.RemoveAll(target); err != nil {
		deps.Log("notify: could not install terminal-notifier: " + err.Error())
		return installFailed
	}
	if err := os.Rename(unpacked, target); err != nil {
		deps.Log("notify: could not install terminal-notifier: " + err.Error())
		return installFailed
	}
	deps.Log("notify: installed terminal-notifier " + release.Version + " in " + target)
	return installed
}

// tnFinder gives the terminal-notifier to use: majhi's own copy, else one on PATH. When there is
// none and deps.Download is set, it starts the install in the background and gives "", so this
// notification is not shown and a later one uses the new copy. A checksum mismatch stops tries
// until the helper restarts; other failures retry after an hour.
type tnFinder struct {
	deps    sys.Deps
	release NotifierRelease
	now     func() time.Time

	mu         sync.Mutex
	ready      string
	installing bool
	retryAt    time.Time
}

func (f *tnFinder) find() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.ready != "" {
		return f.ready
	}
	own := tnInstalledProgram(f.deps.MajhiHome)
	if f.deps.Exists(own) {
		f.ready = own
		return own
	}
	if onPath := f.deps.Find("terminal-notifier"); onPath != "" {
		return onPath
	}
	if f.deps.Download != nil && !f.installing && !f.now().Before(f.retryAt) {
		f.installing = true
		f.deps.Log("notify: installing terminal-notifier " + f.release.Version + " so a click opens majhi")
		go func() {
			result := installTerminalNotifier(f.deps, f.release)
			f.mu.Lock()
			defer f.mu.Unlock()
			f.installing = false
			switch result {
			case installed:
				f.ready = tnInstalledProgram(f.deps.MajhiHome)
			case installMismatch:
				f.retryAt = time.Unix(math.MaxInt64/2, 0)
			default:
				f.retryAt = f.now().Add(installRetry)
			}
		}()
	}
	return ""
}
