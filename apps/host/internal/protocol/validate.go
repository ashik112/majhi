package protocol

import "strings"

// The shapes the shared schemas check with regular expressions, written as plain character rules.

func allOf(s string, ok func(r rune) bool) bool {
	for _, r := range s {
		if !ok(r) {
			return false
		}
	}
	return true
}

func isLower(r rune) bool { return r >= 'a' && r <= 'z' }
func isDigit(r rune) bool { return r >= '0' && r <= '9' }
func isUpper(r rune) bool { return r >= 'A' && r <= 'Z' }
func isHex(r rune) bool   { return isDigit(r) || (r >= 'a' && r <= 'f') }

// IsID is a lowercase id: `[a-z0-9][a-z0-9-]{0,62}`.
func IsID(s string) bool {
	if s == "" || len(s) > 63 {
		return false
	}
	if s[0] == '-' {
		return false
	}
	return allOf(s, func(r rune) bool { return isLower(r) || isDigit(r) || r == '-' })
}

func isTokenID(s, prefix string) bool {
	rest, ok := strings.CutPrefix(s, prefix)
	if !ok || len(rest) < 12 || len(rest) > 32 {
		return false
	}
	return allOf(rest, func(r rune) bool { return isLower(r) || isUpper(r) || isDigit(r) })
}

// IsSignInID is `si_` and 12 to 32 letters or digits.
func IsSignInID(s string) bool { return isTokenID(s, "si_") }

// IsCloneID is `cl_` and 12 to 32 letters or digits.
func IsCloneID(s string) bool { return isTokenID(s, "cl_") }

// IsCommit is a git commit or a prefix of one: 7 to 64 lowercase hex characters.
func IsCommit(s string) bool {
	return len(s) >= 7 && len(s) <= 64 && allOf(s, isHex)
}

// IsFingerprint is the 16 hex characters of a secrets key fingerprint.
func IsFingerprint(s string) bool { return len(s) == 16 && allOf(s, isHex) }

// IsSecretsKeyLine is one `AGE-SECRET-KEY-1...` line of at most 256 characters.
func IsSecretsKeyLine(s string) bool {
	rest, ok := strings.CutPrefix(s, "AGE-SECRET-KEY-1")
	if !ok || rest == "" || len(s) > 256 {
		return false
	}
	return allOf(rest, func(r rune) bool { return isUpper(r) || isDigit(r) })
}

// IsCliTool is one of the command-line tools majhi signs in to.
func IsCliTool(s string) bool {
	switch s {
	case "vercel", "stripe", "aws", "gcloud", "az":
		return true
	}
	return false
}

// NormalizeGitHost trims and lowercases a git host name and checks it: `gitlab.com` or `host:8443`.
func NormalizeGitHost(raw string) (string, bool) {
	host := strings.ToLower(strings.TrimSpace(raw))
	if host == "" || len(host) > 255 {
		return "", false
	}
	name, port, hasPort := strings.Cut(host, ":")
	if hasPort {
		if port == "" || len(port) > 5 || !allOf(port, isDigit) {
			return "", false
		}
	}
	if name == "" || !allOf(name, func(r rune) bool { return isLower(r) || isDigit(r) || r == '.' || r == '-' }) {
		return "", false
	}
	edge := func(c byte) bool { return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') }
	if !edge(name[0]) || !edge(name[len(name)-1]) {
		return "", false
	}
	return host, true
}

// IsHostName is a plain host name with an optional port, as `git credential fill` and `gh auth token` take it.
func IsHostName(s string) bool {
	name, port, hasPort := strings.Cut(s, ":")
	if name == "" || !allOf(name, func(r rune) bool { return isLower(r) || isUpper(r) || isDigit(r) || r == '.' || r == '-' }) {
		return false
	}
	return !hasPort || (port != "" && allOf(port, isDigit))
}

// IsPlainBranch is a branch name made of letters, digits and `._/-`, starting with a letter or digit.
func IsPlainBranch(s string) bool {
	if s == "" {
		return false
	}
	first := rune(s[0])
	if !(isLower(first) || isUpper(first) || isDigit(first)) {
		return false
	}
	return allOf(s, func(r rune) bool {
		return isLower(r) || isUpper(r) || isDigit(r) || r == '.' || r == '_' || r == '/' || r == '-'
	})
}
