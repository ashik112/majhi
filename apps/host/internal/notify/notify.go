// Package notify shows desktop notifications through the OS's notifier, as plain lines, with a
// click that can open only a majhi page.
package notify

import (
	"net/url"
	"strings"
	"unicode/utf8"

	"majhi/host/internal/hostlog"
)

// Request is one notification, already made safe by PlainLine and ClickURL.
type Request struct {
	Title   string
	Message string
	// URL is the majhi page a click opens. Empty when a click opens nothing.
	URL   string
	Sound bool
}

// Kind says what a notification came to.
type Kind string

// The outcomes of a notification. Blocked: the OS has notifications off for majhi's notifier
// (macOS exit code 3), which only the owner can turn on. Unavailable: no notifier is installed yet.
// Failed: it ran and did not show one.
const (
	Shown       Kind = "shown"
	Blocked     Kind = "blocked"
	Unavailable Kind = "unavailable"
	Failed      Kind = "failed"
)

// Outcome is what a notification came to.
type Outcome struct {
	Kind Kind
	// Clickable is true when a click opens the URL (Shown only).
	Clickable bool
	Error     string
}

// Notifier shows a notification. Linux and WSL2 return an error in plain words when nothing was
// shown; the server then keeps the notice in the app only.
type Notifier interface {
	Show(request Request) (Outcome, error)
}

// Preparer builds or installs the notifier now, so the first notification is not lost (macOS).
type Preparer interface{ Prepare() error }

// SettingsOpener opens System Settings at Notifications (macOS).
type SettingsOpener interface{ OpenSettings() bool }

// ClickURL is the page a click opens: majhi's address and a path. Anything but a plain path gives "".
func ClickURL(baseURL, path string) string {
	if path == "" || !strings.HasPrefix(path, "/") || strings.HasPrefix(path, "//") {
		return ""
	}
	base, err := url.Parse(baseURL + "/")
	if err != nil {
		return ""
	}
	ref, err := url.Parse(path)
	if err != nil {
		return ""
	}
	joined := base.ResolveReference(ref)
	if joined.Scheme != base.Scheme || joined.Host != base.Host {
		return ""
	}
	return joined.String()
}

// PlainLine is text that is safe in any notifier: no control characters, one line, a bounded length.
func PlainLine(text string, max int) string {
	var flat strings.Builder
	for _, r := range text {
		if r < 32 || r == 127 || r == 0x2028 || r == 0x2029 {
			flat.WriteRune(' ')
		} else {
			flat.WriteRune(r)
		}
	}
	line := strings.Join(strings.Fields(flat.String()), " ")
	if utf8.RuneCountInString(line) > max {
		runes := []rune(line)
		return string(runes[:max-1]) + "…"
	}
	return line
}

// Params are what a `notify` job asks for.
type Params struct {
	Title   string
	Message string
	Path    string
	Sound   bool
}

// Show shows a notification as plain lines. baseURL is majhi's address, like http://127.0.0.1:7070.
func Show(n Notifier, baseURL string, p Params) (Outcome, error) {
	return n.Show(Request{
		Title:   PlainLine(p.Title, 120),
		Message: PlainLine(p.Message, 300),
		URL:     ClickURL(baseURL, p.Path),
		Sound:   p.Sound,
	})
}

// offNotifier only logs, for a helper next to a test server (MAJHI_HOST_NOTIFY=off).
type offNotifier struct {
	inner Notifier
	log   hostlog.Logger
}

func (o offNotifier) Show(r Request) (Outcome, error) {
	o.log("notify (off): " + r.Title + ": " + r.Message)
	return Outcome{Kind: Shown}, nil
}

// OpenSettings still works with notifications off: opening Settings is the owner's own click.
func (o offNotifier) OpenSettings() bool {
	if s, ok := o.inner.(SettingsOpener); ok {
		return s.OpenSettings()
	}
	return false
}

// Desktop is the notifier the helper uses: the OS's, or with MAJHI_HOST_NOTIFY=off one that only logs.
// A helper next to a test server shows nothing on the owner's desktop and never builds or downloads a notifier.
func Desktop(enabled bool, n Notifier, log hostlog.Logger) Notifier {
	if enabled {
		return n
	}
	return offNotifier{inner: n, log: log}
}
