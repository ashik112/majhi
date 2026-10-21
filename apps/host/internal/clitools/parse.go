// Package clitools signs a workspace in to a git host's CLI (`gh`, `glab`) and to a command-line
// tool (vercel, stripe, aws, gcloud, az) with the tool's own login, in folders of the workspace's
// own, so the owner's own login and another workspace's are never read or changed.
//
// The tool's output is only searched for the page, the code and who is signed in. It is never
// logged, put in an error or sent anywhere, so a token in it cannot leak.
package clitools

import (
	"net/url"
	"strings"
)

// urlMarker is what the browser script prints, so the page is found whatever the CLI itself says.
const urlMarker = "MAJHI_LOGIN_URL"

func isAlnum(c byte) bool {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')
}

func isWord(c byte) bool { return isAlnum(c) || c == '_' }

func isUpperAlnum(c byte) bool { return (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') }

// codeAt reads `XXXX-XXXX` at s[at:] (letters and digits, upper-cased), or "".
func codeAt(s string, at int, upperOnly bool) string {
	if at+9 > len(s) || s[at+4] != '-' {
		return ""
	}
	for i := 0; i < 9; i++ {
		if i == 4 {
			continue
		}
		c := s[at+i]
		if upperOnly && !isUpperAlnum(c) {
			return ""
		}
		if !upperOnly && !isAlnum(c) {
			return ""
		}
	}
	return strings.ToUpper(s[at : at+9])
}

// webURL is the first http(s) URL after marker (up to whitespace), normalised, or "".
func webURL(text string) string {
	end := 0
	for end < len(text) && !isSpace(text[end]) {
		end++
	}
	return cleanWebURL(text[:end])
}

func isSpace(c byte) bool {
	return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v'
}

func cleanWebURL(raw string) string {
	if !strings.HasPrefix(raw, "http://") && !strings.HasPrefix(raw, "https://") {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") {
		return ""
	}
	u.Host = strings.ToLower(u.Host)
	if u.Path == "" {
		u.Path = "/"
	}
	return u.String()
}

// afterMarker is the text after the first marker, or ("", false).
func afterMarker(text, marker string) (string, bool) {
	at := strings.Index(text, marker)
	if at < 0 {
		return "", false
	}
	return text[at+len(marker):], true
}

// ParseLoginOutput is the page and one-time code `gh` or `glab` printed. Either may be missing until the CLI prints it.
func ParseLoginOutput(text string) (pageURL, code string) {
	lower := strings.ToLower(text)
	if at := strings.Index(lower, "one-time code"); at >= 0 {
		i := at + len("one-time code")
		for i < len(text) && !isAlnum(text[i]) {
			i++
		}
		code = codeAt(text, i, false)
	}
	if rest, ok := afterMarker(text, urlMarker+" "); ok {
		pageURL = webURL(rest)
	}
	if pageURL == "" {
		if rest, ok := afterMarker(text, "Open this URL to continue in your web browser: "); ok {
			pageURL = webURL(rest)
		}
	}
	return pageURL, code
}

// ParseToolOutput is the page and code a tool printed. Either may be missing until it prints it.
func ParseToolOutput(text string) (pageURL, code string) {
	code = toolCode(text)
	if rest, ok := afterMarker(text, urlMarker+" "); ok {
		pageURL = webURL(rest)
	}
	if pageURL == "" {
		pageURL = firstURL(text)
	}
	return pageURL, code
}

// toolCode finds the code after a word like "code" or "pairing", else any uppercase `XXXX-XXXX` of its own.
func toolCode(text string) string {
	lower := strings.ToLower(text)
	best := -1
	var found string
	for _, keyword := range []string{"code", "pairing"} {
		for from := 0; ; {
			at := strings.Index(lower[from:], keyword)
			if at < 0 {
				break
			}
			start := from + at + len(keyword)
			from = from + at + 1
			// Up to 40 characters that are neither letters, digits nor a line break; a `(` may follow.
			i := start
			for i < len(text) && i-start < 41 && !isAlnum(text[i]) && text[i] != '\n' {
				i++
			}
			if i == start || isWord(text[i-1]) {
				continue
			}
			code := codeAt(text, i, false)
			if code == "" || (i+9 < len(text) && isWord(text[i+9])) {
				continue
			}
			if best < 0 || start < best {
				best, found = start, code
			}
			break
		}
	}
	if found != "" {
		return found
	}
	for i := 0; i+9 <= len(text); i++ {
		if i > 0 && isWord(text[i-1]) {
			continue
		}
		if code := codeAt(text, i, true); code != "" && (i+9 >= len(text) || !isWord(text[i+9])) {
			return code
		}
	}
	return ""
}

// firstURL is the first http(s) URL in text, up to whitespace or a quote or angle bracket.
func firstURL(text string) string {
	for from := 0; from < len(text); {
		at := strings.Index(text[from:], "http")
		if at < 0 {
			return ""
		}
		start := from + at
		from = start + 1
		if !strings.HasPrefix(text[start:], "http://") && !strings.HasPrefix(text[start:], "https://") {
			continue
		}
		end := start
		for end < len(text) && !isSpace(text[end]) && !strings.ContainsRune(`"'<>`, rune(text[end])) {
			end++
		}
		return cleanWebURL(text[start:end])
	}
	return ""
}

// ParseIdentity is who a check command says is signed in: an email, else a short plain first line.
// Never a long token-like string.
func ParseIdentity(text string) string {
	if email := emailIn(text); email != "" {
		return email
	}
	for _, raw := range strings.Split(text, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || len([]rune(line)) > 80 {
			continue
		}
		if hasLongToken(line) || hasSecretLabel(line) {
			continue
		}
		return line
	}
	return ""
}

func isEmailLocal(c byte) bool {
	return isAlnum(c) || strings.IndexByte("._%+-", c) >= 0
}

func isEmailDomain(c byte) bool { return isAlnum(c) || c == '.' || c == '-' }

// emailIn is the first `name@host.tld` in text.
func emailIn(text string) string {
	for at := strings.Index(text, "@"); at >= 0; {
		start := at
		for start > 0 && isEmailLocal(text[start-1]) {
			start--
		}
		end := at + 1
		for end < len(text) && isEmailDomain(text[end]) {
			end++
		}
		domain := text[at+1 : end]
		if start < at && strings.Contains(domain, ".") {
			// The top-level part is letters only, two or more.
			tld := domain[strings.LastIndex(domain, ".")+1:]
			letters := len(tld) >= 2
			for i := 0; i < len(tld); i++ {
				if !((tld[i] >= 'a' && tld[i] <= 'z') || (tld[i] >= 'A' && tld[i] <= 'Z')) {
					letters = false
				}
			}
			if letters && !strings.HasPrefix(domain, ".") {
				return text[start:end]
			}
		}
		next := strings.Index(text[at+1:], "@")
		if next < 0 {
			return ""
		}
		at += 1 + next
	}
	return ""
}

// hasLongToken is true for 24 or more letters, digits and `_-/+=` in a row.
func hasLongToken(line string) bool {
	run := 0
	for i := 0; i < len(line); i++ {
		if isAlnum(line[i]) || strings.IndexByte("_-/+=", line[i]) >= 0 {
			run++
			if run >= 24 {
				return true
			}
		} else {
			run = 0
		}
	}
	return false
}

// hasSecretLabel is true for `token:`, `secret=`, `password :` or `key:` in any case.
func hasSecretLabel(line string) bool {
	lower := strings.ToLower(line)
	for _, label := range []string{"token", "secret", "password", "key"} {
		for from := 0; ; {
			at := strings.Index(lower[from:], label)
			if at < 0 {
				break
			}
			i := from + at + len(label)
			from = from + at + 1
			for i < len(lower) && (lower[i] == ' ' || lower[i] == '\t') {
				i++
			}
			if i < len(lower) && (lower[i] == ':' || lower[i] == '=') {
				return true
			}
		}
	}
	return false
}
