package platform

import (
	"path/filepath"
	"strings"
	"sync"
	"time"

	"majhi/host/internal/notify"
	"majhi/host/internal/protocol"
	"majhi/host/internal/run"
	"majhi/host/internal/sys"
)

// Linux: a Secret Service keyring, the session's SSH agent or majhi's own, a forwarder for the
// container's agent socket, `notify-send`, `xdg-open`, and Docker Engine, a system service the
// helper cannot start.

const (
	systemctlTimeout = 5 * time.Second
	notifyTimeout    = 10 * time.Second
)

// LinuxDesktopVars are what a desktop program may need from the session, besides PATH and HOME.
var LinuxDesktopVars = []string{"DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "BROWSER"}

var linuxSkippedAtHome = map[string]bool{"Music": true, "Pictures": true, "Public": true, "Templates": true, "Videos": true, "snap": true}

const (
	linuxDockerHelp = "Docker is not running. Run sudo systemctl enable --now docker, and majhi starts by itself."
	linuxNotShown   = "This computer did not show the notification. Install libnotify-bin (Debian, Ubuntu) or libnotify."
)

// unquote is the text inside systemd's `$'...'`: C escapes, and octal ones for other bytes.
func unquote(text string) string {
	out := make([]byte, 0, len(text))
	isOctal := func(c byte) bool { return c >= '0' && c <= '7' }
	isHexDigit := func(c byte) bool {
		return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
	}
	hexValue := func(c byte) byte {
		switch {
		case c >= 'a':
			return c - 'a' + 10
		case c >= 'A':
			return c - 'A' + 10
		}
		return c - '0'
	}
	for i := 0; i < len(text); i++ {
		c := text[i]
		if c != '\\' || i+1 >= len(text) {
			out = append(out, c)
			continue
		}
		next := text[i+1]
		switch {
		case i+3 < len(text) && isOctal(next) && isOctal(text[i+2]) && isOctal(text[i+3]):
			out = append(out, (next-'0')<<6|(text[i+2]-'0')<<3|(text[i+3]-'0'))
			i += 3
		case next == 'x' && i+3 < len(text) && isHexDigit(text[i+2]) && isHexDigit(text[i+3]):
			out = append(out, hexValue(text[i+2])<<4|hexValue(text[i+3]))
			i += 3
		default:
			switch next {
			case 'a':
				out = append(out, 7)
			case 'b':
				out = append(out, '\b')
			case 'f':
				out = append(out, '\f')
			case 'n':
				out = append(out, '\n')
			case 'r':
				out = append(out, '\r')
			case 't':
				out = append(out, '\t')
			case 'v':
				out = append(out, '\v')
			default:
				out = append(out, next)
			}
			i++
		}
	}
	return string(out)
}

// ParseEnvironment reads `systemctl --user show-environment` output: `NAME=value`, with `$'...'`
// around a value that needs it.
func ParseEnvironment(output string) map[string]string {
	env := map[string]string{}
	for _, line := range strings.Split(output, "\n") {
		eq := strings.Index(line, "=")
		if eq <= 0 {
			continue
		}
		value := line[eq+1:]
		if len(value) >= 3 && strings.HasPrefix(value, "$'") && strings.HasSuffix(value, "'") {
			value = unquote(value[2 : len(value)-1])
		}
		env[line[:eq]] = value
	}
	return env
}

// userManagerEnv is the systemd user manager's environment, which a desktop session tells its
// display, D-Bus address and agent. It may hold other secrets, so callers read only the names they
// need, and none of it is logged. Empty when there is no user manager.
func userManagerEnv(deps sys.Deps) map[string]string {
	systemctl := deps.Find("systemctl")
	if systemctl == "" {
		return map[string]string{}
	}
	env := map[string]string{"PATH": deps.Path, "HOME": deps.Home}
	for _, name := range []string{"XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"} {
		if value := deps.Env[name]; value != "" {
			env[name] = value
		}
	}
	result := deps.Run(systemctl, []string{"--user", "show-environment"}, run.Options{Env: env, Timeout: systemctlTimeout})
	if result.Code != 0 {
		return map[string]string{}
	}
	return ParseEnvironment(result.Stdout)
}

// SessionEnv is `DesktopEnv()` for Linux and WSL2: PATH and HOME, plus names from the helper's
// environment, filled in from the systemd user manager, since a login service can start before the
// desktop session tells it anything. D-Bus falls back to `$XDG_RUNTIME_DIR/bus` when that socket is there.
func SessionEnv(deps sys.Deps, names []string) func() map[string]string {
	return func() map[string]string {
		env := map[string]string{"PATH": deps.Path, "HOME": deps.Home}
		missing := false
		for _, name := range names {
			if value := deps.Env[name]; value != "" {
				env[name] = value
			}
			if _, ok := env[name]; !ok {
				missing = true
			}
		}
		if missing {
			manager := userManagerEnv(deps)
			for _, name := range names {
				if _, ok := env[name]; !ok && manager[name] != "" {
					env[name] = manager[name]
				}
			}
		}
		for _, name := range names {
			if name != "DBUS_SESSION_BUS_ADDRESS" {
				continue
			}
			if _, ok := env[name]; !ok && env["XDG_RUNTIME_DIR"] != "" {
				bus := filepath.Join(env["XDG_RUNTIME_DIR"], "bus")
				if deps.Exists(bus) {
					env[name] = "unix:path=" + bus
				}
			}
		}
		return env
	}
}

// notifyBody is `&`, `<` and `>` as markup entities, and backslashes doubled: notify-send reads escapes in the body.
func notifyBody(text string) string {
	return strings.NewReplacer(`\`, `\\`, "&", "&amp;", "<", "&lt;", ">", "&gt;").Replace(text)
}

type linuxAgent struct {
	deps        sys.Deps
	composeSock string
	ownAgent    string
	keyring     Keyring
	mu          sync.Mutex
	current     string
	lastNote    string
}

// candidate is path when something answers on it, so a dead socket left by a stopped agent is
// passed over. Never the forwarder's own socket, which would forward to itself.
func (a *linuxAgent) candidate(path string) bool {
	if path == "" || !filepath.IsAbs(path) || filepath.Clean(path) == filepath.Clean(a.composeSock) {
		return false
	}
	return reachable(path)
}

func (a *linuxAgent) Socket() string {
	type found struct{ path, source string }
	var hit *found
	try := func(path, source string) {
		if hit == nil && a.candidate(path) {
			hit = &found{path, source}
		}
	}
	try(trimmed(a.deps.Env["SSH_AUTH_SOCK"]), "the helper's environment")
	if hit == nil {
		try(trimmed(userManagerEnv(a.deps)["SSH_AUTH_SOCK"]), "the systemd user manager")
	}
	try(a.ownAgent, "majhi's own agent")
	note, current := "none", ""
	if hit != nil {
		current = hit.path
		note = hit.path + "|" + hit.source
	}
	a.mu.Lock()
	a.current = current
	changed := note != a.lastNote
	a.lastNote = note
	a.mu.Unlock()
	if changed {
		if hit == nil {
			a.deps.Log("no SSH agent socket in the helper's environment, the systemd user manager or " + a.ownAgent)
		} else {
			a.deps.Log("SSH agent socket " + hit.path + " (from " + hit.source + ")")
		}
	}
	return current
}

func (a *linuxAgent) Passphrases() Keeping {
	if a.keyring.Check().Kind == protocol.KeyringNone {
		return KeepNone
	}
	return KeepKeyring
}

func (a *linuxAgent) ComposeSocket() string { return a.composeSock }

func (a *linuxAgent) Serve() func() {
	return serveAgent(a.composeSock, func(failed string) string {
		// The agent found last, so the container signs with the keys `ssh` loaded.
		a.mu.Lock()
		current := a.current
		a.mu.Unlock()
		if failed == "" && current != "" {
			return current
		}
		return a.Socket()
	}, a.deps.Log)
}

type linuxNotifier struct {
	deps       sys.Deps
	desktopEnv func() map[string]string
}

func (n linuxNotifier) Show(request notify.Request) (notify.Outcome, error) {
	if bin := n.deps.Find("notify-send"); bin != "" {
		title := request.Title
		if title == "" {
			title = "majhi"
		}
		args := []string{"--app-name=majhi", "--", title, notifyBody(request.Message)}
		if n.deps.Run(bin, args, run.Options{Env: n.desktopEnv(), Timeout: notifyTimeout}).Code == 0 {
			return notify.Outcome{Kind: notify.Shown}, nil
		}
	}
	return notify.Outcome{}, notifyError(linuxNotShown)
}

type notifyError string

func (e notifyError) Error() string { return string(e) }

type noEditorApp struct{}

func (noEditorApp) CLICandidates(string) []string       { return nil }
func (noEditorApp) OpenApp(string, string) (bool, bool) { return false, false }

type linuxDocker struct{}

func (linuxDocker) Start() bool                  { return false }
func (linuxDocker) Help(DockerHelpReason) string { return linuxDockerHelp }

type linuxPlatform struct {
	deps       sys.Deps
	desktopEnv func() map[string]string
	keyring    Keyring
	agent      *linuxAgent
	notifier   notify.Notifier
	os         string
}

// NewLinux builds the Linux platform. desktopEnv is nil for the session's own (SessionEnv with
// LinuxDesktopVars); WSL2 passes one with its interop variables.
func NewLinux(deps sys.Deps, desktopEnv func() map[string]string) *linuxPlatform {
	if desktopEnv == nil {
		desktopEnv = SessionEnv(deps, LinuxDesktopVars)
	}
	keyring := secretService{run: deps.Run, find: deps.Find, env: desktopEnv}
	p := &linuxPlatform{deps: deps, desktopEnv: desktopEnv, keyring: keyring, os: protocol.OSLinux}
	p.agent = &linuxAgent{
		deps:        deps,
		composeSock: filepath.Join(deps.MajhiHome, "run", "ssh-agent.sock"),
		ownAgent:    filepath.Join(deps.MajhiHome, "run", "agent.sock"),
		keyring:     keyring,
	}
	p.notifier = linuxNotifier{deps: deps, desktopEnv: desktopEnv}
	return p
}

func (p *linuxPlatform) OS() string                     { return p.os }
func (p *linuxPlatform) Keyring() Keyring               { return p.keyring }
func (p *linuxPlatform) SSHAgent() SSHAgent             { return p.agent }
func (p *linuxPlatform) Notifier() notify.Notifier      { return p.notifier }
func (p *linuxPlatform) Editor() EditorPlatform         { return noEditorApp{} }
func (p *linuxPlatform) Docker() DockerPlatform         { return linuxDocker{} }
func (p *linuxPlatform) SkippedAtHome() map[string]bool { return linuxSkippedAtHome }
func (p *linuxPlatform) DesktopEnv() map[string]string  { return p.desktopEnv() }
func (p *linuxPlatform) runner() programRunner {
	return programRunner{run: p.deps.Run, find: p.deps.Find, env: p.desktopEnv}
}
func (p *linuxPlatform) OpenURL(url string) bool {
	return p.runner().openURL([]string{"xdg-open"}, url)
}
func (p *linuxPlatform) ClipboardCopy(text string) bool {
	return p.runner().copyText(linuxClipboard, text)
}
