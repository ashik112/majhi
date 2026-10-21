// Package service writes and loads the helper's login service: the LaunchAgent on macOS, the systemd
// user units on Linux and WSL2. It is the one writer of those files: `scripts/host.sh install` copies the
// binary out of the image and runs `majhi-host install-service`, and the transition shim of an older
// install does the same (see apps/host/transition).
package service

import (
	"errors"
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"majhi/host/internal/hostlog"
	"majhi/host/internal/protocol"
	"majhi/host/internal/run"
)

// Passthrough are the variables the service keeps from the environment `make up` ran in. Remounts and
// updates run `docker compose` the way `make up` did, so the helper keeps these settings, among them
// the agent socket and Laya's GPU that `make up` picked, the secrets key file, which the helper also
// reads itself, and Laya's mode and CUDA build args, so an update rebuilds Laya too.
var Passthrough = []string{
	"COMPOSE_PROJECT_NAME", "SSH_AGENT_SOCK", "DOCKER_CONFIG", "DOCKER_HOST", "DOCKER_CONTEXT", "MAJHI_SSH_AGENT",
	"MAJHI_LAYA_GPU", "MAJHI_SECRETS_KEY", "MAJHI_LAYA", "MAJHI_LAYA_TORCH_INDEX", "MAJHI_LAYA_DEVICE",
	// The settings of a helper that runs next to a test server must survive a reinstall of its service.
	"MAJHI_HOST_ISOLATED", "MAJHI_HOST_NOTIFY",
}

const (
	hostUnit  = "majhi-host.service"
	agentUnit = "majhi-ssh-agent.service"
	// DefaultLabel is the LaunchAgent's label. MAJHI_HOST_LABEL changes it, so tests never touch the real one.
	DefaultLabel = "dev.majhi.host"
	launchctl    = "/bin/launchctl"
	step         = 20 * time.Second
)

// Options say what to install.
type Options struct {
	// Env is the environment the service keeps: PATH, the passthrough variables, MAJHI_PORT, MAJHI_REPO.
	Env       map[string]string
	OS        string
	Home      string
	MajhiHome string
	// Repo is the majhi checkout (or runtime folder) `docker compose` runs in. Empty: left out.
	Repo string
	// Bin is the helper's own installed path, which the service runs.
	Bin string
	UID int
	Run run.Func
	// Say prints a line for whoever ran the command, in the words of `scripts/host.sh`.
	Say func(string)
	Log hostlog.Logger
	// Sleep waits between tries. Tests replace it.
	Sleep func(time.Duration)
}

func (o *Options) label() string {
	if l := o.Env["MAJHI_HOST_LABEL"]; l != "" {
		return l
	}
	return DefaultLabel
}

func (o *Options) agentsDir() string {
	if d := o.Env["MAJHI_LAUNCH_AGENTS_DIR"]; d != "" {
		return d
	}
	return filepath.Join(o.Home, "Library", "LaunchAgents")
}

func (o *Options) unitDir() string {
	if d := o.Env["MAJHI_SYSTEMD_USER_DIR"]; d != "" {
		return d
	}
	return filepath.Join(o.Home, ".config", "systemd", "user")
}

func (o *Options) logDir() string { return filepath.Join(o.MajhiHome, "logs") }
func (o *Options) runDir() string { return filepath.Join(o.MajhiHome, "run") }

func (o *Options) sleep(d time.Duration) {
	if o.Sleep != nil {
		o.Sleep(d)
		return
	}
	time.Sleep(d)
}

func (o *Options) cmd(file string, args ...string) run.Result {
	return o.Run(file, args, run.Options{Env: map[string]string{"PATH": o.Env["PATH"], "HOME": o.Home}, Timeout: step})
}

// Port is MAJHI_PORT from the environment, else from the checkout's `.env` (where compose reads it
// too), else 7070.
func Port(env map[string]string, repo string) string {
	if p := env["MAJHI_PORT"]; p != "" {
		return p
	}
	if repo != "" {
		if data, err := os.ReadFile(filepath.Join(repo, ".env")); err == nil {
			port := ""
			for _, line := range strings.Split(string(data), "\n") {
				key, value, ok := strings.Cut(line, "=")
				if !ok || strings.TrimSpace(key) != "MAJHI_PORT" {
					continue
				}
				port = strings.Map(func(r rune) rune {
					if r == '"' || r == '\'' || r == '\r' || r == ' ' {
						return -1
					}
					return r
				}, strings.TrimSpace(value))
			}
			if port != "" {
				return port
			}
		}
	}
	return "7070"
}

// variables are the service's environment, in the order the service files list it.
func (o *Options) variables() [][2]string {
	port := Port(o.Env, o.Repo)
	vars := [][2]string{
		{"MAJHI_URL", "http://127.0.0.1:" + port},
		{"MAJHI_HOME", o.MajhiHome},
	}
	if o.Repo != "" {
		vars = append(vars, [2]string{"MAJHI_REPO", o.Repo})
	}
	vars = append(vars, [2]string{"PATH", o.Env["PATH"]}, [2]string{"HOME", o.Home}, [2]string{"MAJHI_PORT", port})
	for _, name := range Passthrough {
		if v := o.Env[name]; v != "" {
			vars = append(vars, [2]string{name, v})
		}
	}
	return vars
}

func xml(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;").Replace(s)
}

// PlistText is the LaunchAgent: the helper runs at login, and launchd starts it again whenever it exits.
func (o *Options) PlistText() string {
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>` + xml(o.label()) + `</string>
  <key>ProgramArguments</key>
  <array>
    <string>` + xml(o.Bin) + `</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
`)
	for _, v := range o.variables() {
		b.WriteString("    <key>" + xml(v[0]) + "</key>\n    <string>" + xml(v[1]) + "</string>\n")
	}
	out := xml(filepath.Join(o.logDir(), "host.out"))
	b.WriteString(`  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>` + out + `</string>
  <key>StandardErrorPath</key>
  <string>` + out + `</string>
</dict>
</plist>
`)
	return b.String()
}

// execProgram is a program on a unit's command line: in double quotes, with % as %%. systemd reads
// specifiers there, but no variables (systemd.service(5)).
func execProgram(s string) string { return `"` + strings.ReplaceAll(s, "%", "%%") + `"` }

// execArg is an argument on a unit's command line: in double quotes, with \ and " escaped, % as %% and
// $ as $$, since systemd reads escapes, specifiers and variables there.
func execArg(s string) string {
	s = strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(s)
	return `"` + strings.NewReplacer("%", "%%", "$", "$$").Replace(s) + `"`
}

// unitPath is the value of a unit's path setting, where systemd reads specifiers and takes the rest as is.
func unitPath(s string) string { return strings.ReplaceAll(s, "%", "%%") }

// envLine is NAME="value" for the helper's EnvironmentFile, with \ " ` and $ escaped (systemd.exec(5)).
// A value with a line break cannot be written that way, so it is left out, and the reason goes to say.
func envLine(name, value string, say func(string)) string {
	if strings.Contains(value, "\n") {
		say("left " + name + " out of the helper's environment: its value has a line break.")
		return ""
	}
	return name + `="` + strings.NewReplacer(`\`, `\\`, `"`, `\"`, "`", "\\`", "$", `\$`).Replace(value) + "\"\n"
}

// EnvFileText is the helper's environment for systemd: the same variables as the LaunchAgent's.
func (o *Options) EnvFileText(say func(string)) string {
	var b strings.Builder
	b.WriteString("# Written by make up (scripts/host.sh) for " + hostUnit + ". make down removes it.\n")
	for _, v := range o.variables() {
		b.WriteString(envLine(v[0], v[1], say))
	}
	return b.String()
}

// HostUnitText is the helper's unit. systemd starts the helper again whenever it exits, with no limit:
// it exits on purpose after an update or a restart from majhi.
func (o *Options) HostUnitText() string {
	out := unitPath(filepath.Join(o.logDir(), "host.out"))
	return `# Written by make up (scripts/host.sh). make down removes it.
[Unit]
Description=majhi host helper
StartLimitIntervalSec=0

[Service]
ExecStart=` + execProgram(o.Bin) + `
EnvironmentFile=` + unitPath(filepath.Join(o.unitDir(), "majhi-host.env")) + `
Restart=always
RestartSec=2
StandardOutput=append:` + out + `
StandardError=append:` + out + `

[Install]
WantedBy=default.target
`
}

// AgentUnitText is majhi's own agent, for when the session has none (decision 3 of the Linux brief). It
// runs apart from the helper, so keys stay loaded when the helper restarts. A socket left by a killed
// agent would stop the next one from starting, so it goes first.
func (o *Options) AgentUnitText(agent, mkdir, rm string) string {
	sock := filepath.Join(o.runDir(), "agent.sock")
	return `# Written by make up (scripts/host.sh). make down removes it.
[Unit]
Description=majhi's SSH agent, for when the session has none

[Service]
ExecStartPre=` + execProgram(mkdir) + ` -p -m 700 ` + execArg(o.runDir()) + `
ExecStartPre=` + execProgram(rm) + ` -f ` + execArg(sock) + `
ExecStart=` + execProgram(agent) + ` -D -a ` + execArg(sock) + `
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`
}

func writeFile(path, text string, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(text), mode); err != nil {
		return err
	}
	if err := os.Chmod(tmp, mode); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// Install writes the service file or files and loads them, so the helper runs as the binary at o.Bin.
// It does not fail for what `scripts/host.sh` only reported (it prints the same words and returns nil);
// it returns an error when the service could not be loaded.
func Install(o Options) error {
	if o.Say == nil {
		o.Say = func(string) {}
	}
	if o.Log == nil {
		o.Log = hostlog.Discard()
	}
	if err := os.MkdirAll(o.logDir(), 0o755); err != nil {
		return fmt.Errorf("make %s: %w", o.logDir(), err)
	}
	if o.OS == protocol.OSMacOS {
		return o.installLaunchAgent()
	}
	return o.installUnits()
}

func (o *Options) installLaunchAgent() error {
	label := o.label()
	plist := filepath.Join(o.agentsDir(), label+".plist")
	if err := writeFile(plist, o.PlistText(), 0o644); err != nil {
		return fmt.Errorf("write %s: %w", plist, err)
	}
	domain := "gui/" + strconv.Itoa(o.UID)
	o.cmd(launchctl, "bootout", domain+"/"+label)
	// bootout returns before the old process has gone, and bootstrap fails until it has.
	loaded := false
	for i := 0; i < 20 && !loaded; i++ {
		if o.cmd(launchctl, "bootstrap", domain, plist).Code == 0 {
			loaded = true
			break
		}
		o.sleep(500 * time.Millisecond)
	}
	if !loaded {
		o.Say("launchctl could not start " + label + " from " + plist + ". Folder browsing and automatic remounts are off.")
		return fmt.Errorf("launchctl could not start %s from %s", label, plist)
	}
	if !o.waitUntil(func() bool {
		res := o.cmd(launchctl, "print", domain+"/"+label)
		return res.Code == 0 && strings.Contains(res.Stdout, "state = running")
	}) {
		o.Say(label + " was loaded but is not running. " + filepath.Join(o.logDir(), "host.out") + " says why.")
		return fmt.Errorf("%s is loaded but not running", label)
	}
	o.Say("running as " + label + ". Logs: make host-logs")
	return nil
}

// waitUntil asks check up to 20 times, half a second apart.
func (o *Options) waitUntil(check func() bool) bool {
	for i := 0; i < 20; i++ {
		if check() {
			return true
		}
		o.sleep(500 * time.Millisecond)
	}
	return false
}

// linger: WSL has no login of its own: Docker Desktop boots the distro at Windows sign-in, and only
// then does a lingering user's systemd start the helper.
func (o *Options) linger() {
	name := o.Env["USER"]
	if name == "" {
		if u, err := user.Current(); err == nil {
			name = u.Username
		}
	}
	if strings.TrimSpace(o.cmd("loginctl", "show-user", name, "--property=Linger").Stdout) == "Linger=yes" {
		return
	}
	if o.cmd("loginctl", "enable-linger", "--no-ask-password", name).Code != 0 {
		o.Say("the helper runs only while a terminal is open in this distro. To start it when Windows starts, run: sudo loginctl enable-linger " + name)
	}
}

func (o *Options) installUnits() error {
	if err := os.MkdirAll(o.unitDir(), 0o755); err != nil {
		return err
	}
	if err := os.MkdirAll(o.runDir(), 0o700); err != nil {
		return err
	}
	if err := os.Chmod(o.runDir(), 0o700); err != nil {
		return err
	}
	if err := writeFile(filepath.Join(o.unitDir(), "majhi-host.env"), o.EnvFileText(func(m string) { fmt.Fprintln(os.Stderr, "host helper: "+m) }), 0o600); err != nil {
		return err
	}
	if err := writeFile(filepath.Join(o.unitDir(), hostUnit), o.HostUnitText(), 0o644); err != nil {
		return err
	}
	agent := ""
	path := o.Env["PATH"]
	a, errA := lookup("ssh-agent", path)
	m, errM := lookup("mkdir", path)
	r, errR := lookup("rm", path)
	if errA == nil && errM == nil && errR == nil {
		if err := writeFile(filepath.Join(o.unitDir(), agentUnit), o.AgentUnitText(a, m, r), 0o644); err != nil {
			return err
		}
		agent = agentUnit
	} else {
		o.Say("ssh-agent was not found, so majhi has no agent of its own: SSH keys reach it only from the session's agent.")
	}
	enable := []string{"--user", "enable", "--quiet"}
	if agent != "" {
		enable = append(enable, agent)
	}
	enable = append(enable, hostUnit)
	// The agent only starts: a restart would drop the keys it holds. The helper restarts on its new binary.
	if o.cmd("systemctl", "--user", "daemon-reload").Code != 0 || o.cmd("systemctl", enable...).Code != 0 {
		o.Say("systemctl could not enable " + hostUnit + ". Folder browsing and automatic remounts are off.")
		return errors.New("systemctl could not enable " + hostUnit)
	}
	if agent != "" && o.cmd("systemctl", "--user", "start", agent).Code != 0 {
		o.Say("systemctl could not start " + agent + ". journalctl --user -u " + agent + " says why.")
	}
	if o.cmd("systemctl", "--user", "restart", hostUnit).Code != 0 {
		o.Say("systemctl could not start " + hostUnit + ". journalctl --user -u " + hostUnit + " says why.")
		return errors.New("systemctl could not start " + hostUnit)
	}
	if !o.waitUntil(func() bool {
		return strings.TrimSpace(o.cmd("systemctl", "--user", "is-active", hostUnit).Stdout) == "active"
	}) {
		o.Say(hostUnit + " did not stay running. journalctl --user -u " + hostUnit + " says why.")
		return errors.New(hostUnit + " is not running")
	}
	if o.OS == protocol.OSWSL {
		o.linger()
	}
	o.Say("running as " + hostUnit + ". Logs: make host-logs")
	return nil
}

// lookup is the absolute path of a program on path, which a unit's command line needs.
func lookup(name, path string) (string, error) {
	found, ok := run.Resolve(name, path)
	if !ok || !filepath.IsAbs(found) {
		return "", errors.New("not found")
	}
	return found, nil
}

// TakeLock makes the lock file `path`. A lock older than stale is left by a run that died and is taken
// over. It returns a function that removes the lock, or an error when another run holds it.
func TakeLock(path string, stale time.Duration) (func(), error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	for try := 0; try < 2; try++ {
		f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err == nil {
			_, _ = f.WriteString(strconv.Itoa(os.Getpid()) + "\n")
			_ = f.Close()
			return func() { _ = os.Remove(path) }, nil
		}
		info, statErr := os.Stat(path)
		if statErr != nil || time.Since(info.ModTime()) < stale {
			return nil, errors.New("another install-service is running")
		}
		_ = os.Remove(path)
	}
	return nil, errors.New("could not take the install lock")
}

// WaitForExit waits until the process with this id is gone, or the time is up.
func WaitForExit(pid int, limit time.Duration) {
	deadline := time.Now().Add(limit)
	for time.Now().Before(deadline) {
		proc, err := os.FindProcess(pid)
		if err != nil || proc.Signal(syscall.Signal(0)) != nil {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
}
