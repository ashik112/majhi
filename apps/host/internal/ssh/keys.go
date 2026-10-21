// Package ssh keeps the SSH agent loaded so majhi's own git can reach remotes over SSH through the
// forwarded socket (SPEC 4.5). Private keys never leave this computer. Nothing here ever prompts:
// ssh tools run without a terminal, with stdin closed and askpass off, except when a key gets its
// passphrase, which goes to `ssh-add` through a throwaway askpass script.
//
// Logs name key files and the first characters of fingerprints, never key contents and never a passphrase.
package ssh

import (
	"errors"
	"path/filepath"
	"strings"

	"majhi/host/internal/paths"
)

// majhiKeyNames: keys majhi makes are named `id_ed25519_majhi`, then `_2` to `_5`, so the helper
// finds them again and reloads them.
var majhiKeyNames = []string{"id_ed25519_majhi", "id_ed25519_majhi_2", "id_ed25519_majhi_3", "id_ed25519_majhi_4", "id_ed25519_majhi_5"}

func defaultKeyNames() []string {
	return append([]string{"id_ed25519", "id_ecdsa", "id_rsa"}, majhiKeyNames...)
}

func hasFold(line, name string) bool {
	return len(line) >= len(name) && strings.EqualFold(line[:len(name)], name)
}

// ParseIdentityFiles are the `IdentityFile` paths from an ssh config, absolute, in file order.
// Tokens it cannot resolve are skipped.
func ParseIdentityFiles(config, home string) []string {
	var out []string
	for _, line := range strings.Split(strings.ReplaceAll(config, "\r\n", "\n"), "\n") {
		line = strings.TrimLeft(line, " \t")
		if !hasFold(line, "IdentityFile") {
			continue
		}
		rest := line[len("IdentityFile"):]
		trimmed := strings.TrimLeft(rest, " \t")
		sep := len(trimmed) != len(rest)
		if strings.HasPrefix(trimmed, "=") {
			trimmed = strings.TrimLeft(trimmed[1:], " \t")
			sep = true
		}
		value := strings.TrimRight(trimmed, " \t\r")
		if !sep || value == "" {
			continue
		}
		if len(value) >= 2 && strings.HasPrefix(value, `"`) && strings.HasSuffix(value, `"`) {
			value = value[1 : len(value)-1]
		}
		if strings.EqualFold(value, "none") {
			continue
		}
		value = strings.ReplaceAll(value, "%d", home)
		value = strings.ReplaceAll(value, "%%", "%")
		if strings.Contains(value, "%") || strings.Contains(value, "${") {
			continue
		}
		value = paths.ExpandHome(value, home)
		if !filepath.IsAbs(value) {
			continue
		}
		out = append(out, strings.TrimSuffix(value, ".pub"))
	}
	return out
}

// Files is what key discovery reads.
type Files struct {
	// ReadText is the file's text, or ok false when it does not exist.
	ReadText func(path string) (string, bool)
	Exists   func(path string) bool
	Home     string
}

func (f Files) candidates() []string {
	config, _ := f.ReadText(filepath.Join(f.Home, ".ssh", "config"))
	all := ParseIdentityFiles(config, f.Home)
	for _, name := range defaultKeyNames() {
		all = append(all, filepath.Join(f.Home, ".ssh", name))
	}
	seen := map[string]bool{}
	var unique []string
	for _, c := range all {
		if !seen[c] {
			seen[c] = true
			unique = append(unique, c)
		}
	}
	return unique
}

// DiscoverKeys are the private key files that exist: the config's `IdentityFile` entries, then the default names. Each once.
func DiscoverKeys(f Files) []string {
	var found []string
	for _, c := range f.candidates() {
		if f.Exists(c) {
			found = append(found, c)
		}
	}
	return found
}

// DiscoverPublicKeys are the public key files (`<key>.pub`) that exist, for the keys `~/.ssh/config`
// and the default names point to. The private file need not exist. These are what majhi mounts
// read-only, so ssh in the container can pick the matching agent key when the config says `IdentitiesOnly yes`.
func DiscoverPublicKeys(f Files) []string {
	var found []string
	for _, c := range f.candidates() {
		if f.Exists(c + ".pub") {
			found = append(found, c+".pub")
		}
	}
	return found
}

// FreeKeyName is the first name in dir that is free, so a key already there is never touched.
func FreeKeyName(exists func(string) bool, dir string) (string, error) {
	for _, name := range append([]string{"id_ed25519"}, majhiKeyNames...) {
		path := filepath.Join(dir, name)
		if !exists(path) && !exists(path+".pub") {
			return path, nil
		}
	}
	return "", errors.New("~/.ssh already holds every key name majhi uses. Remove a key you no longer need.")
}

// ParseFingerprints are the SHA256 fingerprints from `ssh-add -l` or `ssh-keygen -l` output, one per line.
func ParseFingerprints(output string) []string {
	var out []string
	for _, line := range strings.Split(output, "\n") {
		if fp := fingerprintIn(line); fp != "" {
			out = append(out, fp)
		}
	}
	return out
}

func fingerprintIn(line string) string {
	const marker = "SHA256:"
	for from := 0; ; {
		at := strings.Index(line[from:], marker)
		if at < 0 {
			return ""
		}
		start := from + at
		from = start + 1
		if start > 0 && isWordByte(line[start-1]) {
			continue
		}
		end := start + len(marker)
		for end < len(line) && (isAlnumByte(line[end]) || line[end] == '+' || line[end] == '/') {
			end++
		}
		if end > start+len(marker) {
			return line[start:end]
		}
	}
}

func isAlnumByte(c byte) bool {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
}

func isWordByte(c byte) bool { return isAlnumByte(c) || c == '_' }

// ShortFingerprint is `SHA256:AbCdEfGh...` shortened for the log.
func ShortFingerprint(fingerprint string) string {
	short := strings.TrimPrefix(fingerprint, "SHA256:")
	if len(short) > 8 {
		short = short[:8]
	}
	return short
}

// IsWake is true when the time since the last tick shows the machine was asleep.
func IsWake(last, now int64, tickMs int64) bool { return now-last > tickMs+WakeGapMs }

// The wake check looks at the clock this often, and calls a tick this much late a sleep.
const (
	WakeTickMs = 60_000
	WakeGapMs  = 2 * 60_000
)
