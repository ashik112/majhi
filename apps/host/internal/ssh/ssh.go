package ssh

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"majhi/host/internal/hostlog"
	"majhi/host/internal/paths"
	"majhi/host/internal/platform"
	"majhi/host/internal/protocol"
	"majhi/host/internal/run"
)

// SSHAdd and SSHKeygen are Apple's own ssh tools, which know the Keychain. Elsewhere the ones on PATH are used.
const (
	SSHAdd         = "/usr/bin/ssh-add"
	SSHKeygen      = "/usr/bin/ssh-keygen"
	commandTimeout = 10 * time.Second
	noTools        = "ssh-add and ssh-keygen are not installed. Install openssh-client (Debian, Ubuntu) or openssh."
	noAgentText    = "The SSH agent is not running, so there is nothing to load keys into."
	noAgentUnlock  = "The SSH agent is not running."
)

// Agent is the agent keys are loaded into, and where a passphrase is kept.
type Agent interface {
	Socket() string
	Passphrases() platform.Keeping
}

// PassphraseKeyring is where passphrases are kept when the agent says `keyring`.
type PassphraseKeyring interface {
	Read(item platform.KeyringItem) (string, bool, error)
	Write(item platform.KeyringItem, secret string) error
	Remove(item platform.KeyringItem) error
}

// Deps are what the SSH key work needs.
type Deps struct {
	Run      run.Func
	ReadText func(path string) (string, bool)
	Exists   func(path string) bool
	Home     string
	// Path is the PATH the ssh tools run with.
	Path string
	// Find is the absolute path of the first executable `name` on Path, or "".
	Find    func(name string) string
	Agent   Agent
	Keyring PassphraseKeyring
	Log     hostlog.Logger
	Now     func() time.Time
	// RuntimeDir is `$XDG_RUNTIME_DIR`. The askpass's throwaway folder goes there while the folder
	// exists: it is the owner's alone, and in memory under systemd.
	RuntimeDir string
	// TmpRoot is where the askpass's throwaway folder goes otherwise. Empty: the system's temp folder.
	TmpRoot string
	// DryRun: report only, skip everything that changes the agent or the keyring.
	DryRun bool
	// EnsureDir makes `~/.ssh` (owner only) before a key is made in it. Nil: the real one.
	EnsureDir func(dir string) error
}

// KeyState is what became of one key.
type KeyState string

// The states of a key after a check.
const (
	Loaded          KeyState = "loaded"
	Added           KeyState = "added"
	WouldAdd        KeyState = "would-add"
	NeedsPassphrase KeyState = "needs-passphrase"
	AddFailed       KeyState = "add-failed"
	Unreadable      KeyState = "unreadable"
)

// KeyReport is one key after a check.
type KeyReport struct {
	// Path is the path with `~`.
	Path string
	// Fingerprint is the first characters of the SHA256 fingerprint, when the key could be read.
	Fingerprint string
	State       KeyState
}

// Report is what a check found.
type Report struct {
	Status protocol.SSHStatus
	Keys   []KeyReport
	Socket string
}

type session struct {
	sshAdd, sshKeygen string
	keeping           platform.Keeping
	socket            string
	env               map[string]string
}

// Ssh keeps the agent loaded. Calls queue, one at a time.
type Ssh struct {
	deps   Deps
	queue  sync.Mutex
	mu     sync.Mutex
	latest *protocol.SSHStatus
}

// New builds it.
func New(deps Deps) *Ssh {
	if deps.Now == nil {
		deps.Now = time.Now
	}
	if deps.TmpRoot == "" {
		deps.TmpRoot = os.TempDir()
	}
	return &Ssh{deps: deps}
}

// Status is the result of the last check, or nil before the first one ends.
func (s *Ssh) Status() *protocol.SSHStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.latest == nil {
		return nil
	}
	copied := *s.latest
	return &copied
}

func (s *Ssh) baseEnv(socket string) map[string]string {
	path := s.deps.Path
	if path == "" {
		path = "/usr/bin:/bin"
	}
	return map[string]string{
		"PATH": path, "HOME": s.deps.Home,
		// Nothing may prompt. `never` turns askpass off; the false program is a second lock.
		"SSH_ASKPASS": "/usr/bin/false", "SSH_ASKPASS_REQUIRE": "never",
		"SSH_AUTH_SOCK": socket,
	}
}

// openSession is the tools and the agent, or why there are none, in plain words.
func (s *Ssh) openSession(noAgent string) (*session, error) {
	keeping := s.deps.Agent.Passphrases()
	add, keygen := SSHAdd, SSHKeygen
	if keeping != platform.KeepApple {
		add, keygen = s.deps.Find("ssh-add"), s.deps.Find("ssh-keygen")
		if add == "" || keygen == "" {
			return nil, errors.New(noTools)
		}
	}
	socket := s.deps.Agent.Socket()
	if socket == "" {
		return nil, errors.New(noAgent)
	}
	return &session{add, keygen, keeping, socket, s.baseEnv(socket)}, nil
}

// agentFingerprints are the keys the agent holds. ok is false when it did not answer.
func (s *Ssh) agentFingerprints(sess *session) (map[string]bool, bool) {
	list := s.deps.Run(sess.sshAdd, []string{"-l"}, run.Options{Env: sess.env, Timeout: commandTimeout})
	// Exit 1: the agent answered and holds no keys. Anything else but 0: it did not answer.
	if list.Code == 1 {
		return map[string]bool{}, true
	}
	if list.Code != 0 {
		return nil, false
	}
	set := map[string]bool{}
	for _, fp := range ParseFingerprints(list.Stdout) {
		set[fp] = true
	}
	return set, true
}

func (s *Ssh) fingerprintOf(sess *session, key string) string {
	source := key
	if s.deps.Exists(key + ".pub") {
		source = key + ".pub"
	}
	res := s.deps.Run(sess.sshKeygen, []string{"-lf", source}, run.Options{Env: sess.env, Timeout: commandTimeout})
	if res.Code != 0 {
		return ""
	}
	if fps := ParseFingerprints(res.Stdout); len(fps) > 0 {
		return fps[0]
	}
	return ""
}

// askpassRoot is `$XDG_RUNTIME_DIR` while it is a folder, else the temp folder. Looked up each time: logging out removes it.
func (s *Ssh) askpassRoot() string {
	runtime := s.deps.RuntimeDir
	if runtime == "" || !filepath.IsAbs(runtime) {
		return s.deps.TmpRoot
	}
	if info, err := os.Stat(runtime); err == nil && info.IsDir() {
		return runtime
	}
	return s.deps.TmpRoot
}

func shellQuote(text string) string { return "'" + strings.ReplaceAll(text, "'", `'\''`) + "'" }

// askpassScript is an askpass that gives the passphrase in `<dir>/p` once. ssh-add asks a second
// time only when the passphrase was wrong; that question gets an empty answer, which ends ssh-add
// at once, and leaves `<dir>/again` behind. Only shell builtins, so it runs where `/bin/cat` is missing.
func askpassScript(dir string) string {
	asked := shellQuote(filepath.Join(dir, "asked"))
	return strings.Join([]string{
		"#!/bin/sh",
		"if [ -e " + asked + " ]; then",
		"  : > " + shellQuote(filepath.Join(dir, "again")),
		"  exit 1",
		"fi",
		": > " + asked,
		"IFS= read -r p < " + shellQuote(filepath.Join(dir, "p")),
		`printf '%s\n' "$p"`,
		"",
	}, "\n")
}

type addResult int

const (
	addedKey addResult = iota
	wrongPassphrase
	failedKey
	notAsked
)

func onDisk(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// addWithPassphrase is `ssh-add key` with its passphrase, through the askpass in a private folder
// that is removed after. wrong: ssh-add asked again, which it does only for a wrong passphrase.
// notAsked: it stopped before it ran the askpass, so the passphrase was never tried. failed: it
// asked once and still failed, like an agent that refused the key.
func (s *Ssh) addWithPassphrase(sess *session, key, passphrase string) (addResult, error) {
	dir, err := os.MkdirTemp(s.askpassRoot(), "majhi-askpass-")
	if err != nil {
		return failedKey, fmt.Errorf("make the askpass folder: %w", err)
	}
	defer os.RemoveAll(dir)
	if err := os.Chmod(dir, 0o700); err != nil {
		return failedKey, err
	}
	script := filepath.Join(dir, "askpass.sh")
	if err := os.WriteFile(filepath.Join(dir, "p"), []byte(passphrase), 0o600); err != nil {
		return failedKey, err
	}
	if err := os.WriteFile(script, []byte(askpassScript(dir)), 0o700); err != nil {
		return failedKey, err
	}
	env := map[string]string{}
	for k, v := range sess.env {
		env[k] = v
	}
	env["SSH_ASKPASS"] = script
	env["SSH_ASKPASS_REQUIRE"] = "force"
	env["DISPLAY"] = ":0"
	// Apple's ssh-add keeps the passphrase in the Keychain as it adds the key.
	args := []string{key}
	if sess.keeping == platform.KeepApple {
		args = []string{"--apple-use-keychain", key}
	}
	// The result is judged by the exit code and the askpass's marks. Output is logged only when
	// ssh-add failed for another reason than a wrong passphrase, to say why; it never holds the passphrase.
	res := s.deps.Run(sess.sshAdd, args, run.Options{Env: env, Timeout: commandTimeout * 3})
	if res.Code == 0 {
		return addedKey, nil
	}
	asked := onDisk(filepath.Join(dir, "asked"))
	if asked && onDisk(filepath.Join(dir, "again")) {
		return wrongPassphrase, nil
	}
	lines := strings.Split(strings.TrimSpace(res.Stderr), "\n")
	why := lines[len(lines)-1]
	if why == "" {
		if res.Code == run.NoCode {
			why = "exit none"
		} else {
			why = fmt.Sprintf("exit %d", res.Code)
		}
	}
	shown := paths.CollapseHome(key, s.deps.Home)
	if asked {
		s.deps.Log(fmt.Sprintf("ssh-add took the passphrase of %s once, then stopped: %s", shown, why))
		return failedKey, nil
	}
	s.deps.Log(fmt.Sprintf("ssh-add stopped before it asked for the passphrase of %s: %s", shown, why))
	return notAsked, nil
}

// loadKept loads a key that needs a passphrase with the one the keyring kept for it. A wrong one is removed.
func (s *Ssh) loadKept(sess *session, key, path, label string) KeyState {
	if sess.keeping != platform.KeepKeyring || s.deps.DryRun {
		return NeedsPassphrase
	}
	item := platform.SSHPassphraseItem(path)
	kept, found, err := s.deps.Keyring.Read(item)
	if err != nil {
		s.deps.Log(fmt.Sprintf("could not read the kept passphrase for %s: %s", path, err))
	}
	if err != nil || !found {
		return NeedsPassphrase
	}
	added, err := s.addWithPassphrase(sess, key, kept)
	if err != nil {
		s.deps.Log(fmt.Sprintf("ssh-add could not load %s with its kept passphrase", path))
		return AddFailed
	}
	switch added {
	case addedKey:
		s.deps.Log("loaded " + label + " with its kept passphrase")
		return Added
	case failedKey, notAsked:
		s.deps.Log(fmt.Sprintf("ssh-add could not load %s with its kept passphrase", path))
		return AddFailed
	}
	if err := s.deps.Keyring.Remove(item); err != nil {
		s.deps.Log(fmt.Sprintf("the kept passphrase for %s no longer unlocks it, and removing it failed: %s", path, err))
	} else {
		s.deps.Log(fmt.Sprintf("the kept passphrase for %s no longer unlocks it, so it was removed from the keyring", path))
	}
	return NeedsPassphrase
}

func (s *Ssh) check() Report {
	checkedAt := s.deps.Now().UTC().Format("2006-01-02T15:04:05.000Z")
	failure := func(message, socket string, keys []KeyReport) Report {
		return Report{Status: protocol.SSHStatus{NeedsPassphrase: []string{}, Error: message, CheckedAt: checkedAt}, Keys: keys, Socket: socket}
	}
	sess, err := s.openSession(noAgentText)
	if err != nil {
		return failure(err.Error(), "", nil)
	}
	if sess.keeping == platform.KeepApple && !s.deps.DryRun {
		// Apple's ssh-add only: it reads passphrases the Keychain already holds.
		keychain := s.deps.Run(sess.sshAdd, []string{"--apple-load-keychain"}, run.Options{Env: sess.env, Timeout: commandTimeout})
		if keychain.Code != 0 {
			s.deps.Log("ssh-add --apple-load-keychain ended with " + codeText(keychain.Code))
		}
	}
	before, ok := s.agentFingerprints(sess)
	if !ok {
		return failure("Cannot reach the SSH agent at "+sess.socket+".", sess.socket, nil)
	}
	loaded := map[string]bool{}
	for fp := range before {
		loaded[fp] = true
	}
	var keys []KeyReport
	for _, key := range DiscoverKeys(Files{ReadText: s.deps.ReadText, Exists: s.deps.Exists, Home: s.deps.Home}) {
		path := paths.CollapseHome(key, s.deps.Home)
		fingerprint := s.fingerprintOf(sess, key)
		short := ""
		if fingerprint != "" {
			short = ShortFingerprint(fingerprint)
		}
		label := path
		if short != "" {
			label = fmt.Sprintf("%s (%s)", path, short)
		}
		if fingerprint != "" && loaded[fingerprint] {
			keys = append(keys, KeyReport{path, short, Loaded})
			continue
		}
		// Success with an empty passphrase means the key has none.
		probe := s.deps.Run(sess.sshKeygen, []string{"-y", "-P", "", "-f", key}, run.Options{Env: sess.env, Timeout: commandTimeout})
		switch {
		case probe.Code == 0:
			if s.deps.DryRun {
				keys = append(keys, KeyReport{path, short, WouldAdd})
				continue
			}
			added := s.deps.Run(sess.sshAdd, []string{key}, run.Options{Env: sess.env, Timeout: commandTimeout})
			if added.Code == 0 {
				if fingerprint != "" {
					loaded[fingerprint] = true
				}
				s.deps.Log("loaded " + label)
				keys = append(keys, KeyReport{path, short, Added})
			} else {
				s.deps.Log(fmt.Sprintf("ssh-add could not load %s (exit %s)", path, codeTextNone(added.Code)))
				keys = append(keys, KeyReport{path, short, AddFailed})
			}
		case strings.Contains(strings.ToLower(probe.Stderr), "passphrase"):
			state := s.loadKept(sess, key, path, label)
			if state == Added && fingerprint != "" {
				loaded[fingerprint] = true
			}
			keys = append(keys, KeyReport{path, short, state})
		default:
			keys = append(keys, KeyReport{path, short, Unreadable})
		}
	}
	after := before
	if !s.deps.DryRun {
		after, ok = s.agentFingerprints(sess)
		if !ok {
			return failure("Cannot reach the SSH agent at "+sess.socket+".", sess.socket, keys)
		}
	}
	needs := []string{}
	for _, k := range keys {
		if k.State == NeedsPassphrase {
			needs = append(needs, k.Path)
		}
	}
	return Report{Status: protocol.SSHStatus{Loaded: len(after), NeedsPassphrase: needs, CheckedAt: checkedAt}, Keys: keys, Socket: sess.socket}
}

func codeText(code int) string {
	if code == run.NoCode {
		return "no exit code"
	}
	return fmt.Sprint(code)
}

func codeTextNone(code int) string {
	if code == run.NoCode {
		return "none"
	}
	return fmt.Sprint(code)
}

func summarize(status protocol.SSHStatus) string {
	noun := "keys"
	if status.Loaded == 1 {
		noun = "key"
	}
	parts := []string{fmt.Sprintf("%d %s loaded", status.Loaded, noun)}
	if needs := len(status.NeedsPassphrase); needs > 0 {
		verb := "need"
		if needs == 1 {
			verb = "needs"
		}
		parts = append(parts, fmt.Sprintf("%d %s a passphrase (%s)", needs, verb, strings.Join(status.NeedsPassphrase, ", ")))
	}
	if status.Error != "" {
		parts = append(parts, status.Error)
	}
	return strings.Join(parts, ", ")
}

func (s *Ssh) runCheck() Report {
	report := s.check()
	s.mu.Lock()
	status := report.Status
	s.latest = &status
	s.mu.Unlock()
	s.deps.Log("SSH keys: " + summarize(report.Status))
	return report
}

// Reload loads keys into the agent and checks what is left. Calls queue, one at a time.
func (s *Ssh) Reload() (protocol.SSHStatus, error) {
	s.queue.Lock()
	defer s.queue.Unlock()
	return s.runCheck().Status, nil
}

// Inspect is Reload with the per-key report as well.
func (s *Ssh) Inspect() Report {
	s.queue.Lock()
	defer s.queue.Unlock()
	return s.runCheck()
}

// Unlock gives a key its passphrase once. It fails with a plain message on refusal.
func (s *Ssh) Unlock(key, passphrase string) (protocol.SSHStatus, error) {
	s.queue.Lock()
	defer s.queue.Unlock()
	shown := paths.CollapseHome(key, s.deps.Home)
	latest := s.Status()
	waiting := false
	if latest != nil {
		for _, p := range latest.NeedsPassphrase {
			if p == shown {
				waiting = true
			}
		}
	}
	if !waiting {
		return protocol.SSHStatus{}, fmt.Errorf("%s is not waiting for a passphrase.", shown)
	}
	sess, err := s.openSession(noAgentUnlock)
	if err != nil {
		return protocol.SSHStatus{}, err
	}
	added, err := s.addWithPassphrase(sess, paths.ExpandHome(key, s.deps.Home), passphrase)
	if err != nil {
		return protocol.SSHStatus{}, err
	}
	// Apple's tools mean macOS. Linux and WSL2 share one command.
	command := UnlockCommand(shown, sess.keeping == platform.KeepApple)
	switch added {
	case notAsked:
		return protocol.SSHStatus{}, fmt.Errorf("The passphrase was not tried: ssh-add stopped before it asked for it. Unlock %s in a terminal: %s", shown, command)
	case failedKey:
		return protocol.SSHStatus{}, fmt.Errorf("ssh-add could not load %s. Unlock it in a terminal to see why: %s", shown, command)
	case wrongPassphrase:
		s.deps.Log("unlock of " + shown + " failed")
		return protocol.SSHStatus{}, fmt.Errorf("That passphrase did not unlock %s.", shown)
	}
	switch sess.keeping {
	case platform.KeepApple:
		s.deps.Log("unlocked " + shown + "; the Keychain holds its passphrase now")
	case platform.KeepNone:
		s.deps.Log("unlocked " + shown + "; with no keyring, its passphrase is kept nowhere")
	default:
		if err := s.deps.Keyring.Write(platform.SSHPassphraseItem(shown), passphrase); err != nil {
			s.deps.Log(fmt.Sprintf("unlocked %s, but the keyring did not keep its passphrase: %s", shown, err))
		} else {
			s.deps.Log("unlocked " + shown + "; the keyring holds its passphrase now")
		}
	}
	return s.runCheck().Status, nil
}

// UnlockCommand is the terminal fallback that unlocks a passphrase-protected key. On macOS it also
// gives the passphrase to the Keychain. Elsewhere it loads the key into the agent majhi uses.
func UnlockCommand(key string, macos bool) string {
	if !macos {
		return "SSH_AUTH_SOCK=" + protocol.HostSSHAgentSocket + " ssh-add " + key
	}
	return "ssh-add --apple-use-keychain " + key
}

// MakeKey makes an ed25519 key with no passphrase in a free name in `~/.ssh` and loads it into the
// agent. It never replaces a key. It fails with a plain sentence.
func (s *Ssh) MakeKey() (protocol.MadeSSHKey, error) {
	s.queue.Lock()
	defer s.queue.Unlock()
	sess, err := s.openSession(noAgentText)
	if err != nil {
		return protocol.MadeSSHKey{}, err
	}
	dir := filepath.Join(s.deps.Home, ".ssh")
	ensure := s.deps.EnsureDir
	if ensure == nil {
		ensure = func(d string) error { return os.MkdirAll(d, 0o700) }
	}
	if err := ensure(dir); err != nil {
		return protocol.MadeSSHKey{}, fmt.Errorf("Cannot make %s: %v", dir, err)
	}
	path, err := FreeKeyName(s.deps.Exists, dir)
	if err != nil {
		return protocol.MadeSSHKey{}, err
	}
	// No passphrase: majhi never asks for one. `-f` on a name that is free cannot overwrite anything.
	made := s.deps.Run(sess.sshKeygen, []string{"-t", "ed25519", "-N", "", "-C", "majhi", "-f", path}, run.Options{Env: sess.env, Timeout: commandTimeout})
	text, _ := s.deps.ReadText(path + ".pub")
	publicKey := strings.TrimSpace(text)
	if made.Code != 0 || publicKey == "" {
		s.deps.Log(fmt.Sprintf("ssh-keygen could not make %s (exit %s)", paths.CollapseHome(path, s.deps.Home), codeTextNone(made.Code)))
		return protocol.MadeSSHKey{}, errors.New("ssh-keygen could not make a key. Check that ~/.ssh is writable, then try again.")
	}
	s.deps.Log("made " + paths.CollapseHome(path, s.deps.Home))
	// The agent offers it to every host from now on, whatever its name.
	s.deps.Run(sess.sshAdd, []string{path}, run.Options{Env: sess.env, Timeout: commandTimeout})
	s.runCheck()
	return protocol.MadeSSHKey{
		Path:        paths.CollapseHome(path, s.deps.Home),
		PublicKey:   publicKey,
		Fingerprint: s.fingerprintOf(sess, path),
	}, nil
}

// Start checks now (the helper starts at login) and again after every wake from sleep. Keys stay
// loaded while the owner is logged in, so there is no periodic reload. The returned function stops it.
func (s *Ssh) Start(onWake func(at time.Time)) func() {
	go s.Reload()
	stop := make(chan struct{})
	go func() {
		ticker := time.NewTicker(WakeTickMs * time.Millisecond)
		defer ticker.Stop()
		// Wall clock, not the monotonic one: on macOS the monotonic clock stops while the computer sleeps.
		last := time.Now().Round(0).UnixMilli()
		for {
			select {
			case <-stop:
				return
			case t := <-ticker.C:
				at := t.Round(0).UnixMilli()
				if IsWake(last, at, WakeTickMs) {
					s.deps.Log("woke from sleep; checking SSH keys")
					if onWake != nil {
						onWake(time.UnixMilli(at))
					}
					go s.Reload()
				}
				last = at
			}
		}
	}()
	return func() { close(stop) }
}
