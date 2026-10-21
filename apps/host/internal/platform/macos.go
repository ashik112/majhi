package platform

import (
	"errors"
	"path/filepath"
	"sync"
	"time"

	"majhi/host/internal/notify"
	"majhi/host/internal/protocol"
	"majhi/host/internal/run"
	"majhi/host/internal/sys"
)

// macOS, as the helper always ran there: the login Keychain through `security`, launchd's SSH agent
// with Apple's ssh-add keeping passphrases, the agent socket Docker Desktop and OrbStack give
// containers, majhi's own notifier app (built by the helper) or terminal-notifier, `open`, and
// OrbStack or Docker Desktop to start.

const (
	securityBin = "/usr/bin/security"
	launchctl   = "/bin/launchctl"
	openBin     = "/usr/bin/open"
	// securityNotFound is what `security` exits with when the item is not there.
	securityNotFound = 44
	keychainTimeout  = 15 * time.Second
	launchTimeout    = 10 * time.Second
	openMacTimeout   = 15 * time.Second
	// hostServicesSocket is what Docker Desktop and OrbStack mount for the Mac's agent.
	hostServicesSocket = "/run/host-services/ssh-auth.sock"
)

var dockerApps = []string{"OrbStack", "Docker"}

// macEditorApps are each editor's app, and its command inside the app for when it is not on PATH.
var macEditorApps = map[string]struct{ appName, bundle string }{
	"vscode": {"Visual Studio Code", "Visual Studio Code.app/Contents/Resources/app/bin/code"},
	"cursor": {"Cursor", "Cursor.app/Contents/Resources/app/bin/cursor"},
}

// macSkippedAtHome are folders in home that hold apps, media, system data or virtual machines, never
// projects. `OrbStack` is OrbStack's view into its containers and machines: slow to read (about 50 s
// for a few thousand folders) and never a workspace root.
var macSkippedAtHome = map[string]bool{
	"Library": true, "Applications": true, "Movies": true, "Music": true,
	"Pictures": true, "Public": true, "OrbStack": true,
}

var macDockerHelp = map[DockerHelpReason]string{
	NotStarted: "Install OrbStack or Docker Desktop, open it once, and majhi starts by itself.",
	Slow:       "Docker did not start in 2 minutes. Open OrbStack or Docker Desktop, and majhi starts by itself.",
}

// plainField is true when nothing in value can end or break a quoted `security -i` argument.
func plainField(value string) bool {
	for _, r := range value {
		if r < 32 || r == 127 || r == '"' || r == '\\' {
			return false
		}
	}
	return true
}

func isPlainSecret(secret string) bool {
	if secret == "" {
		return false
	}
	for _, r := range secret {
		if !((r >= 'A' && r <= 'Z') || (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-') {
			return false
		}
	}
	return true
}

type keychain struct{ run run.Func }

func (k keychain) env() map[string]string { return map[string]string{"PATH": "/usr/bin:/bin"} }

// Check: the login Keychain is always there. A locked one shows when a call fails.
func (k keychain) Check() protocol.KeyringState {
	return protocol.KeyringState{Kind: protocol.KeyringKeychain}
}

func (k keychain) Read(item KeyringItem) (string, bool, error) {
	result := k.run(securityBin, []string{"find-generic-password", "-s", item.Service, "-a", item.Account, "-w"},
		run.Options{Env: k.env(), Timeout: keychainTimeout})
	if result.Code == securityNotFound {
		return "", false, nil
	}
	if result.Code != 0 {
		return "", false, errors.New("The Keychain did not answer. Is it locked?")
	}
	return trimOneNewline(result.Stdout), true, nil
}

func trimOneNewline(s string) string {
	if len(s) > 0 && s[len(s)-1] == '\n' {
		return s[:len(s)-1]
	}
	return s
}

func (k keychain) Write(item KeyringItem, secret string) error {
	// `security -i` reads the secret inside a command line, so only plain words may go there.
	if !isPlainSecret(secret) {
		return errors.New("This secret cannot go to the Keychain.")
	}
	for _, field := range []string{item.Service, item.Account, item.Label, item.Comment} {
		if !plainField(field) {
			return errors.New("This item cannot go to the Keychain.")
		}
	}
	quote := func(v string) string { return `"` + v + `"` }
	command := "add-generic-password -U -s " + quote(item.Service) + " -a " + quote(item.Account) + " -l " + quote(item.Label)
	if item.Comment != "" {
		command += " -j " + quote(item.Comment)
	}
	command += " -w " + secret
	result := k.run(securityBin, []string{"-i"}, run.Options{Env: k.env(), Timeout: keychainTimeout, Input: command + "\nquit\n"})
	// `security -i` can exit 0 after a failed command, so the copy is read back to be sure.
	back, found, err := k.Read(item)
	if result.Code != 0 || err != nil || !found || back != secret {
		return errors.New("The Keychain did not take the " + item.Label + ". Is it locked?")
	}
	return nil
}

func (k keychain) Remove(item KeyringItem) error {
	result := k.run(securityBin, []string{"delete-generic-password", "-s", item.Service, "-a", item.Account},
		run.Options{Env: k.env(), Timeout: keychainTimeout})
	if result.Code != 0 && result.Code != securityNotFound {
		return errors.New("The Keychain did not answer. Is it locked?")
	}
	return nil
}

type macAgent struct {
	deps        sys.Deps
	mu          sync.Mutex
	lastNote    string
	composeSock string
}

func (a *macAgent) Socket() string {
	own := trimmed(a.deps.Env["SSH_AUTH_SOCK"])
	got := a.deps.Run(launchctl, []string{"getenv", "SSH_AUTH_SOCK"},
		run.Options{Env: map[string]string{"PATH": a.deps.Path, "HOME": a.deps.Home}, Timeout: launchTimeout})
	launchd := ""
	if got.Code == 0 {
		launchd = trimmed(got.Stdout)
	}
	socket := own
	if socket == "" {
		socket = launchd
	}
	note := socket + "|" + launchd
	if socket == "" {
		note = "none|" + launchd
	}
	a.mu.Lock()
	changed := note != a.lastNote
	a.lastNote = note
	a.mu.Unlock()
	if changed {
		if socket == "" {
			a.deps.Log("no SSH agent socket in the helper's environment or from launchctl")
		} else {
			source := "launchctl"
			if own != "" {
				source = "the helper's environment"
			}
			a.deps.Log("SSH agent socket " + socket + " (from " + source + ")")
			if own != "" && launchd != "" && own != launchd {
				a.deps.Log("launchd holds a different agent socket, " + launchd + "; the container is served by that one")
			}
		}
	}
	return socket
}

func (a *macAgent) Passphrases() Keeping  { return KeepApple }
func (a *macAgent) ComposeSocket() string { return a.composeSock }
func (a *macAgent) Serve() func()         { return func() {} }

type macEditor struct{ deps sys.Deps }

func (e macEditor) CLICandidates(app string) []string {
	var out []string
	for _, dir := range []string{"/Applications", filepath.Join(e.deps.Home, "Applications")} {
		out = append(out, filepath.Join(dir, macEditorApps[app].bundle))
	}
	return out
}

func (e macEditor) OpenApp(app, path string) (bool, bool) {
	result := e.deps.Run(openBin, []string{"-a", macEditorApps[app].appName, path},
		run.Options{Env: map[string]string{"PATH": e.deps.Path, "HOME": e.deps.Home}, Timeout: openMacTimeout})
	return result.Code == 0, true
}

type macDocker struct{ deps sys.Deps }

func (d macDocker) Start() bool {
	env := map[string]string{"PATH": d.deps.Path, "HOME": d.deps.Home}
	for _, app := range dockerApps {
		for _, dir := range []string{"/Applications", filepath.Join(d.deps.Home, "Applications")} {
			if !d.deps.Exists(filepath.Join(dir, app+".app")) {
				continue
			}
			opened := d.deps.Run(openBin, []string{"-a", app}, run.Options{Env: env, Timeout: openMacTimeout})
			if opened.Code == 0 {
				d.deps.Log("startup: opened " + app)
				return true
			}
			d.deps.Log("startup: could not open " + app)
		}
	}
	return false
}

func (d macDocker) Help(reason DockerHelpReason) string { return macDockerHelp[reason] }

type macPlatform struct {
	deps     sys.Deps
	keyring  keychain
	agent    *macAgent
	notifier notify.Notifier
}

// NewMacOS builds the macOS platform. `notifier` is the notifier to use (see NewMacNotifier).
func NewMacOS(deps sys.Deps, notifier notify.Notifier) Platform {
	compose := trimmed(deps.Env["SSH_AGENT_SOCK"])
	if compose == "" {
		// An older `make up` let SSH_AGENT_SOCK pick another socket, and the LaunchAgent passes it on.
		compose = hostServicesSocket
	}
	return &macPlatform{
		deps:     deps,
		keyring:  keychain{run: deps.Run},
		agent:    &macAgent{deps: deps, composeSock: compose},
		notifier: notifier,
	}
}

func (p *macPlatform) OS() string                     { return protocol.OSMacOS }
func (p *macPlatform) Keyring() Keyring               { return p.keyring }
func (p *macPlatform) SSHAgent() SSHAgent             { return p.agent }
func (p *macPlatform) Notifier() notify.Notifier      { return p.notifier }
func (p *macPlatform) Editor() EditorPlatform         { return macEditor{p.deps} }
func (p *macPlatform) Docker() DockerPlatform         { return macDocker{p.deps} }
func (p *macPlatform) SkippedAtHome() map[string]bool { return macSkippedAtHome }
func (p *macPlatform) DesktopEnv() map[string]string {
	return map[string]string{"PATH": p.deps.Path, "HOME": p.deps.Home}
}
func (p *macPlatform) runner() programRunner {
	return programRunner{run: p.deps.Run, find: p.deps.Find, env: p.DesktopEnv}
}
func (p *macPlatform) OpenURL(url string) bool { return p.runner().openURL([]string{"open"}, url) }
func (p *macPlatform) ClipboardCopy(text string) bool {
	return p.runner().copyText(macClipboard, text)
}
