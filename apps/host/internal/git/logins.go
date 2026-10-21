package git

import (
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"majhi/host/internal/protocol"
	"majhi/host/internal/run"
)

// Finds out which accounts this computer is logged in as on git hosts: `gh` and `glab` logins, and
// the SSH keys each host or `~/.ssh/config` alias accepts. Every probe is short and fails alone.
// DetectLogins never reads a token. ReadToken is the only code that does.

var knownHosts = []string{"github.com", "gitlab.com", "bitbucket.org"}

const (
	cliTimeout = 8 * time.Second
	sshTimeout = 9 * time.Second
)

func isWordChar(c byte) bool {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_'
}

func isAlnum(c byte) bool {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
}

// ParseGreeting is the account named by a git host's `ssh -T` greeting, or "" when the key was not accepted.
func ParseGreeting(output string) string {
	lower := strings.ToLower(output)
	if containsAny(lower, "permission denied", "could not resolve", "connection refused", "connection timed out", "connection closed") {
		return ""
	}
	if name := githubGreeting(output); name != "" {
		return name
	}
	if rest, ok := cutAfter(output, "Welcome to GitLab, @"); ok {
		end := 0
		for end < len(rest) && !isSpace(rest[end]) && rest[end] != '!' {
			end++
		}
		if end > 0 && end < len(rest) && rest[end] == '!' {
			return rest[:end]
		}
	}
	if rest, ok := cutAfterFold(output, "logged in as "); ok {
		end := 0
		for end < len(rest) && !isSpace(rest[end]) {
			end++
		}
		name := strings.TrimSuffix(rest[:end], ".")
		if name != "" && !strings.HasPrefix(name, ".") && !strings.Contains(name, "..") {
			return name
		}
	}
	return ""
}

// githubGreeting reads `Hi <name>! You've successfully authenticated`.
func githubGreeting(output string) string {
	const tail = "! You've successfully authenticated"
	for from := 0; ; {
		at := strings.Index(output[from:], "Hi ")
		if at < 0 {
			return ""
		}
		start := from + at
		from = start + 1
		if start > 0 && isWordChar(output[start-1]) {
			continue
		}
		name := output[start+3:]
		end := 0
		for end < len(name) && (isAlnum(name[end]) || name[end] == '-') {
			end++
		}
		if end == 0 || !isAlnum(name[0]) || !strings.HasPrefix(name[end:], tail) {
			continue
		}
		return name[:end]
	}
}

func cutAfter(s, marker string) (string, bool) {
	at := strings.Index(s, marker)
	if at < 0 {
		return "", false
	}
	return s[at+len(marker):], true
}

func cutAfterFold(s, marker string) (string, bool) {
	return cutAfter(strings.ToLower(s), strings.ToLower(marker)) // same length for ASCII markers
}

// AcceptedWithoutAccount is true when the host took the key but its greeting names no account:
// Bitbucket answers "authenticated via ssh key." and nothing else.
func AcceptedWithoutAccount(output string) bool {
	lower := strings.ToLower(output)
	if containsAny(lower, "permission denied", "could not resolve", "connection refused", "connection timed out") {
		return false
	}
	return strings.Contains(lower, "authenticated via ssh key") && ParseGreeting(output) == ""
}

// AcceptedFingerprint is the SHA256 fingerprint of the key the server accepted, from `ssh -v`
// output. ssh prints the public key's fingerprint itself ("Server accepts key: <path> ED25519
// SHA256:..."), so no key file is read.
func AcceptedFingerprint(verbose string) string {
	found := ""
	for _, line := range strings.Split(strings.ReplaceAll(verbose, "\r\n", "\n"), "\n") {
		if !strings.Contains(line, "Server accepts key:") {
			continue
		}
		for _, word := range strings.Fields(line) {
			if strings.HasPrefix(word, "SHA256:") && len(word) > len("SHA256:") {
				found = word
				break
			}
		}
	}
	return found
}

// AuthAccount is one login from `gh auth status` or `glab auth status`.
type AuthAccount struct{ Host, Account string }

// ParseAuthStatus reads accounts per host from `gh auth status` or `glab auth status` output (stdout and stderr together).
func ParseAuthStatus(output string) []AuthAccount {
	const marker = "Logged in to "
	var out []AuthAccount
	for from := 0; ; {
		at := strings.Index(output[from:], marker)
		if at < 0 {
			return out
		}
		rest := output[from+at+len(marker):]
		from += at + len(marker)
		host, after, ok := strings.Cut(rest, " ")
		if !ok || host == "" || strings.ContainsAny(host, "\t\r\n") {
			continue
		}
		var tail string
		if t, ok := strings.CutPrefix(after, "account "); ok {
			tail = t
		} else if t, ok := strings.CutPrefix(after, "as "); ok {
			tail = t
		} else {
			continue
		}
		end := 0
		for end < len(tail) && !isSpace(tail[end]) && tail[end] != '(' {
			end++
		}
		if end > 0 {
			out = append(out, AuthAccount{strings.ToLower(host), tail[:end]})
		}
	}
}

// SSHAlias is a `Host` alias of ~/.ssh/config with its `HostName`, lowercase.
type SSHAlias struct{ Alias, HostName string }

// ParseSSHAliases reads `Host` aliases (no wildcards) with their `HostName`.
func ParseSSHAliases(text string) []SSHAlias {
	var out []SSHAlias
	var aliases []string
	for _, raw := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n") {
		keyword, arg, ok := splitKeyword(raw)
		if !ok {
			continue
		}
		switch keyword {
		case "host":
			aliases = aliases[:0:0]
			for _, a := range strings.Fields(arg) {
				if !strings.ContainsAny(a, "*?!") {
					aliases = append(aliases, a)
				}
			}
		case "match":
			aliases = nil
		default:
			if fields := strings.Fields(arg); len(fields) > 0 {
				for _, alias := range aliases {
					out = append(out, SSHAlias{alias, strings.ToLower(fields[0])})
				}
			}
			aliases = nil
		}
	}
	return out
}

// splitKeyword reads `Keyword value` or `Keyword=value` for the three keywords this file cares about.
func splitKeyword(line string) (keyword, arg string, ok bool) {
	line = strings.TrimLeft(line, " \t")
	for _, name := range []string{"hostname", "match", "host"} {
		if !hasPrefixFold(line, name) {
			continue
		}
		rest := line[len(name):]
		trimmed := strings.TrimLeft(rest, " \t")
		sep := len(trimmed) != len(rest)
		if strings.HasPrefix(trimmed, "=") {
			trimmed = strings.TrimLeft(trimmed[1:], " \t")
			sep = true
		}
		if !sep {
			continue
		}
		return name, strings.TrimRight(trimmed, " \t\r"), true
	}
	return "", "", false
}

// LoginsDeps are what the login probes need.
type LoginsDeps struct {
	Run  run.Func
	Home string
	Path string
	// ReadText is the file's text, or ok false when it does not exist.
	ReadText func(path string) (string, bool)
	// Socket is the SSH agent's socket, as the platform finds it. "" when none.
	Socket func() string
	// Find is the absolute path of `gh` or `glab`, or "" when not installed.
	Find func(name string) string
	// SSH is the ssh that greets the git hosts. A test helper points it at one that never leaves the machine.
	SSH string
}

func cliEnv(deps LoginsDeps) map[string]string {
	return map[string]string{"PATH": deps.Path, "HOME": deps.Home, "NO_COLOR": "1", "GH_PROMPT_DISABLED": "1"}
}

// DetectLogins finds the accounts this computer is logged in as, per host.
func DetectLogins(deps LoginsDeps, extraHosts []string) []protocol.GitHostLogins {
	var mu sync.Mutex
	byHost := map[string][]protocol.GitLogin{}
	keysByHost := map[string][]protocol.GitAcceptedKey{}
	add := func(host string, login protocol.GitLogin) {
		mu.Lock()
		defer mu.Unlock()
		for _, l := range byHost[host] {
			if l.Via == login.Via && l.Alias == login.Alias && l.Account == login.Account {
				return
			}
		}
		byHost[host] = append(byHost[host], login)
	}

	for _, via := range []string{"gh", "glab"} {
		file := deps.Find(via)
		if file == "" {
			continue
		}
		result := deps.Run(file, []string{"auth", "status"}, run.Options{Env: cliEnv(deps), Timeout: cliTimeout})
		for _, a := range ParseAuthStatus(result.Stdout + "\n" + result.Stderr) {
			add(a.Host, protocol.GitLogin{Via: via, Account: a.Account})
		}
	}

	hosts := map[string]bool{}
	var order []string
	for _, h := range append(append([]string{}, knownHosts...), lowerAll(extraHosts)...) {
		if !hosts[h] {
			hosts[h] = true
			order = append(order, h)
		}
	}
	type target struct{ host, alias, target string }
	var targets []target
	for _, h := range order {
		targets = append(targets, target{h, "", h})
	}
	if config, ok := deps.ReadText(deps.Home + "/.ssh/config"); ok {
		for _, a := range ParseSSHAliases(config) {
			if hosts[a.HostName] {
				targets = append(targets, target{a.HostName, a.Alias, a.Alias})
			}
		}
	}
	env := map[string]string{
		"PATH": deps.Path, "HOME": deps.Home,
		"SSH_ASKPASS": "/usr/bin/false", "SSH_ASKPASS_REQUIRE": "never",
	}
	if socket := deps.Socket(); socket != "" {
		env["SSH_AUTH_SOCK"] = socket
	}
	var wg sync.WaitGroup
	for _, t := range targets {
		wg.Add(1)
		go func() {
			defer wg.Done()
			result := deps.Run(deps.SSH, []string{"-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "git@" + t.target},
				run.Options{Env: env, Timeout: sshTimeout})
			output := result.Stdout + "\n" + result.Stderr
			if account := ParseGreeting(output); account != "" {
				add(t.host, protocol.GitLogin{Via: "ssh", Alias: t.alias, Account: account})
			} else if AcceptedWithoutAccount(output) {
				verbose := deps.Run(deps.SSH, []string{"-T", "-v", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "git@" + t.target},
					run.Options{Env: env, Timeout: sshTimeout})
				fingerprint := AcceptedFingerprint(verbose.Stdout + "\n" + verbose.Stderr)
				mu.Lock()
				keysByHost[t.host] = append(keysByHost[t.host], protocol.GitAcceptedKey{Alias: t.alias, Fingerprint: fingerprint})
				mu.Unlock()
			}
		}()
	}
	wg.Wait()

	names := map[string]bool{}
	for h := range byHost {
		names[h] = true
	}
	for h := range keysByHost {
		names[h] = true
	}
	sorted := make([]string, 0, len(names))
	for h := range names {
		sorted = append(sorted, h)
	}
	sort.Strings(sorted)
	out := make([]protocol.GitHostLogins, 0, len(sorted))
	for _, host := range sorted {
		logins := byHost[host]
		if logins == nil {
			logins = []protocol.GitLogin{}
		}
		// The two probes of one host finish in either order; keep the output steady.
		sort.SliceStable(logins, func(i, j int) bool { return loginRank(logins[i]) < loginRank(logins[j]) })
		out = append(out, protocol.GitHostLogins{Host: host, Logins: logins, Keys: keysByHost[host]})
	}
	return out
}

func loginRank(l protocol.GitLogin) string { return l.Via + "\x00" + l.Alias + "\x00" + l.Account }

func lowerAll(list []string) []string {
	out := make([]string, len(list))
	for i, s := range list {
		out[i] = strings.ToLower(s)
	}
	return out
}

// ReadToken reads one CLI login's token. The caller hands it to the org's secrets and keeps no copy.
func ReadToken(deps LoginsDeps, via, host string) (string, error) {
	if !isPlainHost(host) {
		return "", errors.New("That is not a git host name.")
	}
	file := deps.Find(via)
	if file == "" {
		return "", fmt.Errorf("%s is not installed on this computer.", via)
	}
	args := []string{"config", "get", "token", "--host", host}
	if via == "gh" {
		args = []string{"auth", "token", "--hostname", host}
	}
	result := deps.Run(file, args, run.Options{
		Env:     map[string]string{"PATH": deps.Path, "HOME": deps.Home, "NO_COLOR": "1"},
		Timeout: cliTimeout,
	})
	token := strings.TrimSpace(result.Stdout)
	if result.Code != 0 || token == "" {
		// The message never carries the command output.
		return "", fmt.Errorf("%s has no login for %s on this computer.", via, host)
	}
	return token, nil
}

func isPlainHost(host string) bool {
	if host == "" {
		return false
	}
	for _, r := range host {
		if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '.' || r == '-') {
			return false
		}
	}
	return true
}

// ReadTextFile is the real LoginsDeps.ReadText.
func ReadTextFile(path string) (string, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", false
	}
	return string(data), true
}
