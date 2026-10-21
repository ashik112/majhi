package platform

import (
	"net/url"
	"strings"
	"time"

	"majhi/host/internal/run"
)

const openTimeout = 8 * time.Second

// openURL opens an http(s) page in the owner's default browser with the first opener that works:
// `open` on macOS, `xdg-open` on Linux, `wslview` (else `explorer.exe`) on WSL2. The URL is one
// argument, never a shell string. False when it is not http(s), or no opener exists or worked.
func (r programRunner) openURL(openers []string, raw string) bool {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return false
	}
	parsed.Host = strings.ToLower(parsed.Host)
	if parsed.Path == "" {
		parsed.Path = "/"
	}
	for _, name := range openers {
		bin := r.find(name)
		if bin == "" {
			continue
		}
		result := r.run(bin, []string{parsed.String()}, run.Options{Env: r.env(), Timeout: openTimeout})
		// explorer.exe answers 1 even when it opened the page.
		if result.Code == 0 || (name == "explorer.exe" && result.Code == 1) {
			return true
		}
	}
	return false
}
