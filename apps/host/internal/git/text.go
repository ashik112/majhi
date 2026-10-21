package git

import (
	"net/url"
	"strings"
)

// containsAny is true when lower holds any of the phrases. git prints plain sentences, never a
// code, so its failures are told apart by what they say; each phrase is exact text git or the host prints.
func containsAny(lower string, phrases ...string) bool {
	for _, p := range phrases {
		if strings.Contains(lower, p) {
			return true
		}
	}
	return false
}

// StripCredentials drops `user:pass@` (and a lone token) from every URL in text.
func StripCredentials(text string) string {
	var out strings.Builder
	for i := 0; i < len(text); {
		scheme := 0
		switch {
		case hasPrefixFold(text[i:], "https://"):
			scheme = len("https://")
		case hasPrefixFold(text[i:], "http://"):
			scheme = len("http://")
		}
		if scheme == 0 {
			out.WriteByte(text[i])
			i++
			continue
		}
		out.WriteString(text[i : i+scheme])
		i += scheme
		end := i
		for end < len(text) && !isSpace(text[end]) && text[end] != '/' && text[end] != '@' {
			end++
		}
		if end > i && end < len(text) && text[end] == '@' {
			i = end + 1 // the user info and its `@` are dropped
		}
	}
	return out.String()
}

func hasPrefixFold(s, prefix string) bool {
	return len(s) >= len(prefix) && strings.EqualFold(s[:len(prefix)], prefix)
}

func isSpace(c byte) bool {
	return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v'
}

// IsHTTPSAuthFailure is true when the text looks like git could not log in.
func IsHTTPSAuthFailure(text string) bool {
	lower := strings.ToLower(text)
	if containsAny(lower, "authentication failed", "could not read username", "could not read password",
		"terminal prompts disabled", "invalid credentials", "http 401", "http 403",
		"returned error: 401", "returned error: 403", "access denied", "bad credentials") {
		return true
	}
	if at := strings.Index(lower, "permission to "); at >= 0 && strings.Contains(lower[at:], " denied") {
		return true
	}
	return false
}

// hostOfRemote is the host of a remote URL (https or ssh://, with or without user info) or an
// scp-style `git@host:path`. "the git host" when it cannot be told.
func hostOfRemote(remote string) string {
	if scheme, rest, ok := strings.Cut(remote, "://"); ok && isSchemeName(scheme) {
		authority, _, _ := strings.Cut(rest, "/")
		if at := strings.LastIndex(authority, "@"); at >= 0 {
			authority = authority[at+1:]
		}
		if host, _, _ := strings.Cut(authority, ":"); host != "" {
			return host
		}
		return "the git host"
	}
	if before, _, ok := strings.Cut(remote, ":"); ok && before != "" && !strings.Contains(before, "/") {
		if at := strings.LastIndex(before, "@"); at >= 0 {
			before = before[at+1:]
		}
		if before != "" {
			return before
		}
	}
	return "the git host"
}

func isSchemeName(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || r == '+') {
			return false
		}
	}
	return true
}

// hostWithPort is `host:port` of a URL, "that host" when it does not parse.
func hostWithPort(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return "that host"
	}
	return u.Host
}

// userOf is the user name in a URL, or "".
func userOf(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.User == nil {
		return ""
	}
	return u.User.Username()
}
