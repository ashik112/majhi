// Package platform holds the helper's per-OS parts behind one interface. New builds the one the
// OS found at start needs. Nothing else in the helper reads runtime.GOOS or names an OS program.
// Implementations run programs only through sys.Deps.Run, so a test fakes an OS by faking its programs.
//
// macOS: launchd, the Keychain, Docker's host-services SSH socket, majhi's notifier app or
// terminal-notifier, `open`. Linux: systemd user units, a Secret Service keyring through
// `secret-tool`, the session's SSH agent, `notify-send`, `xdg-open`. WSL2: Linux, plus Docker
// Desktop, the browser, the editor and toasts on the Windows side, reached through WSL interop.
package platform

import (
	"majhi/host/internal/notify"
	"majhi/host/internal/protocol"
)

// KeyringItem is where a secret sits in the keyring. Names are fixed strings or a key path, never other input.
type KeyringItem struct {
	// Label is what Keychain Access or a keyring app lists the item as.
	Label   string
	Service string
	Account string
	// Comment is what Keychain Access shows (macOS only). A Secret Service item has none.
	Comment string
}

// SecretsKeyItem is the copy of the secrets key. The names are the ones macOS copies already use.
var SecretsKeyItem = KeyringItem{
	Label:   "majhi secrets key",
	Service: "majhi secrets key",
	Account: "secrets.key",
	Comment: "Restores ~/.config/majhi/secrets.key, the key that decrypts ~/.majhi/secrets.age",
}

// SSHPassphraseItem is where an SSH key's passphrase is kept on Linux and WSL2. key is the private key's path with `~`.
func SSHPassphraseItem(key string) KeyringItem {
	return KeyringItem{Label: "majhi SSH key passphrase for " + key, Service: "majhi ssh key", Account: key}
}

// Keyring is where the helper keeps secrets.
type Keyring interface {
	// Check looks for a keyring that answers without showing a prompt. Cheap enough to call before
	// each use. It never fails: a missing or locked keyring is `none` with the reason in plain words.
	Check() protocol.KeyringState
	// Read returns the secret, found false when there is none. It fails in plain words when the keyring did not answer.
	Read(item KeyringItem) (secret string, found bool, err error)
	// Write saves secret over whatever the item held, then reads it back. The secret goes to the
	// program on stdin, never in its arguments, and is never logged or put in an error. macOS takes
	// only letters, digits and dashes (the secrets key), because `security -i` reads the secret
	// inside a command line.
	Write(item KeyringItem, secret string) error
	// Remove deletes the item. One that is not there is fine.
	Remove(item KeyringItem) error
}

// Keeping is where a passphrase given through `ssh.unlock` is kept, so the key loads again after a restart.
type Keeping string

// The ways a passphrase is kept: Apple's ssh-add in the Keychain, the helper in the keyring, or nowhere
// (the key stays loaded until its agent stops).
const (
	KeepApple   Keeping = "apple"
	KeepKeyring Keeping = "keyring"
	KeepNone    Keeping = "none"
)

// SSHAgent is the agent the helper loads keys into, and the socket majhi's server uses.
type SSHAgent interface {
	// Socket is the agent the helper loads keys into, or "" when none is there. macOS: the helper's
	// SSH_AUTH_SOCK, else `launchctl getenv SSH_AUTH_SOCK`. Linux and WSL2: the helper's
	// SSH_AUTH_SOCK, else the one in `systemctl --user show-environment`, else majhi's own agent at
	// `~/.majhi/run/agent.sock`. A path that is not a socket is skipped.
	Socket() string
	// Passphrases is how a passphrase is kept. Linux and WSL2 follow the keyring check.
	Passphrases() Keeping
	// ComposeSocket is the socket majhi's server container uses, given to compose as MAJHI_SSH_AGENT.
	ComposeSocket() string
	// Serve listens on ComposeSocket and pipes each connection to Socket's agent (Linux and WSL2).
	// Failures go to the log. macOS: does nothing. The returned function stops it.
	Serve() (stop func())
}

// EditorPlatform says where an editor's command may be.
type EditorPlatform interface {
	// CLICandidates is where `app`'s command may be when it is not on PATH.
	CLICandidates(app string) []string
	// OpenApp opens path with the app itself (macOS `open -a`). `supported` is false on systems
	// without one; `opened` is false when the app is not there.
	OpenApp(app, path string) (opened, supported bool)
}

// DockerHelpReason says why Docker is still down.
type DockerHelpReason string

// Why Docker is still down: nothing could be started, or it did not come up in 2 minutes.
const (
	NotStarted DockerHelpReason = "not-started"
	Slow       DockerHelpReason = "slow"
)

// DockerPlatform starts Docker where the helper can.
type DockerPlatform interface {
	// Start starts Docker when it is down. True when it started something to wait for: OrbStack or
	// Docker Desktop on macOS, Docker Desktop for Windows from WSL2. False when there is nothing to
	// start, as on Linux, where Docker Engine is a system service that needs root.
	Start() bool
	// Help is the one step the owner must take when Docker stays down, for the notification.
	Help(reason DockerHelpReason) string
}

// Platform is everything that differs per OS.
type Platform interface {
	OS() string
	Keyring() Keyring
	SSHAgent() SSHAgent
	Notifier() notify.Notifier
	Editor() EditorPlatform
	Docker() DockerPlatform
	// SkippedAtHome are the first-level folders of home that never hold projects: apps, media, system data, VMs.
	SkippedAtHome() map[string]bool
	// DesktopEnv is what a desktop program (browser, editor, notification) needs: PATH and HOME, and
	// on Linux and WSL2 the display, D-Bus and WSL interop variables. It is read again on each call.
	DesktopEnv() map[string]string
	// OpenURL opens an http(s) page in the owner's browser. False when nothing opened it. It never fails.
	OpenURL(url string) bool
	// ClipboardCopy puts text on the owner's clipboard through a program's stdin. False when none
	// worked. It never fails and never logs the text.
	ClipboardCopy(text string) bool
}
