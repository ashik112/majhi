package platform

import (
	"errors"
	"strings"
	"time"

	"majhi/host/internal/protocol"
	"majhi/host/internal/run"
)

// The Secret Service keyring on Linux and WSL2 (GNOME Keyring, KWallet, KeePassXC) through
// libsecret's `secret-tool`. `secret-tool` on a locked collection pops an unlock dialog, which a
// login service must never cause, so every use first asks D-Bus whether the default collection is
// unlocked (decision 4). The secret goes to `secret-tool store` on stdin and comes back on stdout.
// It is never in an argument, a log line or an error.

const (
	probeTimeout = 5 * time.Second
	callTimeout  = 15 * time.Second

	noSecretTool = "secret-tool is not installed. Install libsecret-tools (Debian, Ubuntu) or libsecret (Fedora, Arch)."
	noBusctl     = "The keyring cannot be checked without busctl (systemd)."
	noAnswer     = "The keyring did not answer."
)

var lockedProperty = []string{
	"--user", "get-property", "org.freedesktop.secrets", "/org/freedesktop/secrets/aliases/default",
	"org.freedesktop.Secret.Collection", "Locked",
}

// busVars are the names a keyring call gets from the desktop session.
var busVars = []string{"PATH", "HOME", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR"}

type secretService struct {
	run  run.Func
	find func(string) string
	env  func() map[string]string
}

func (s secretService) busEnv() map[string]string {
	session := s.env()
	env := map[string]string{}
	for _, name := range busVars {
		if value, ok := session[name]; ok {
			env[name] = value
		}
	}
	return env
}

func (s secretService) Check() protocol.KeyringState {
	if s.find("secret-tool") == "" {
		return protocol.KeyringState{Kind: protocol.KeyringNone, Reason: noSecretTool}
	}
	busctl := s.find("busctl")
	if busctl == "" {
		return protocol.KeyringState{Kind: protocol.KeyringNone, Reason: noBusctl}
	}
	probe := s.run(busctl, lockedProperty, run.Options{Env: s.busEnv(), Timeout: probeTimeout})
	answer := ""
	if probe.Code == 0 {
		answer = strings.TrimSpace(probe.Stdout)
	}
	switch answer {
	case "b false":
		return protocol.KeyringState{Kind: protocol.KeyringSecretService}
	case "b true":
		return protocol.KeyringState{Kind: protocol.KeyringNone, Reason: "The keyring is locked."}
	}
	return protocol.KeyringState{Kind: protocol.KeyringNone, Reason: "No keyring is running."}
}

// ready is `secret-tool` once the keyring answered unlocked, else the reason it did not.
func (s secretService) ready() (string, error) {
	state := s.Check()
	if state.Kind == protocol.KeyringNone {
		return "", errors.New(state.Reason)
	}
	tool := s.find("secret-tool")
	if tool == "" {
		return "", errors.New(noSecretTool)
	}
	return tool, nil
}

func attributes(item KeyringItem) []string {
	return []string{"service", item.Service, "account", item.Account}
}

// notFound: `secret-tool` exits 1 with nothing on stderr when no item matched.
func notFound(r run.Result) bool { return r.Code == 1 && strings.TrimSpace(r.Stderr) == "" }

func (s secretService) lookup(tool string, item KeyringItem) (string, bool, error) {
	result := s.run(tool, append([]string{"lookup"}, attributes(item)...), run.Options{Env: s.busEnv(), Timeout: callTimeout})
	if result.Code == 0 {
		return result.Stdout, true, nil
	}
	if notFound(result) {
		return "", false, nil
	}
	return "", false, errors.New(noAnswer)
}

func (s secretService) Read(item KeyringItem) (string, bool, error) {
	tool, err := s.ready()
	if err != nil {
		return "", false, err
	}
	return s.lookup(tool, item)
}

func (s secretService) Write(item KeyringItem, secret string) error {
	tool, err := s.ready()
	if err != nil {
		return err
	}
	// The whole of stdin is the secret, so it goes without a trailing newline.
	args := append([]string{"store", "--label=" + item.Label}, attributes(item)...)
	s.run(tool, args, run.Options{Env: s.busEnv(), Timeout: callTimeout, Input: secret})
	// As on macOS, the copy is read back rather than trusting the exit code.
	back, found, err := s.lookup(tool, item)
	if err != nil || !found || back != secret {
		return errors.New("The keyring did not take the " + item.Label + ".")
	}
	return nil
}

func (s secretService) Remove(item KeyringItem) error {
	tool, err := s.ready()
	if err != nil {
		return err
	}
	result := s.run(tool, append([]string{"clear"}, attributes(item)...), run.Options{Env: s.busEnv(), Timeout: callTimeout})
	if result.Code != 0 && !notFound(result) {
		return errors.New(noAnswer)
	}
	return nil
}
