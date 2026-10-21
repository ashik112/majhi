package platform

import (
	"os"
	"runtime"
	"strconv"
	"strings"
	"time"

	"majhi/host/internal/notify"
	"majhi/host/internal/protocol"
	"majhi/host/internal/run"
	"majhi/host/internal/sys"
)

// Facts are what the OS check reads.
type Facts struct {
	GOOS string
	// Release is the kernel release. WSL2 kernels look like `5.15.153.1-microsoft-standard-WSL2`.
	Release string
	Env     map[string]string
}

// IsWSL is true when the kernel release or the environment says this Linux is WSL.
func IsWSL(release string, env map[string]string) bool {
	lower := strings.ToLower(release)
	if strings.Contains(lower, "microsoft") || strings.Contains(lower, "wsl") {
		return true
	}
	_, named := env["WSL_DISTRO_NAME"]
	return named
}

// DetectOS is the helper's OS, or "" where it does not run (Windows itself, the BSDs).
func DetectOS(f Facts) string {
	switch f.GOOS {
	case "darwin":
		return protocol.OSMacOS
	case "linux":
		if IsWSL(f.Release, f.Env) {
			return protocol.OSWSL
		}
		return protocol.OSLinux
	}
	return ""
}

// CurrentOS is the OS the helper runs on, or "".
func CurrentOS(env map[string]string) string {
	release := ""
	if data, err := os.ReadFile("/proc/sys/kernel/osrelease"); err == nil {
		release = strings.TrimSpace(string(data))
	}
	return DetectOS(Facts{GOOS: runtime.GOOS, Release: release, Env: env})
}

// NodePlatform is `HostInfo.platform`: the name Node gives the OS (decision 10), which older servers read.
func NodePlatform() string {
	if runtime.GOOS == "windows" {
		return "win32"
	}
	return runtime.GOOS
}

func trimmed(s string) string { return strings.TrimSpace(s) }

func itoa(n int) string { return strconv.Itoa(n) }

func runOptions(env map[string]string, timeout time.Duration) run.Options {
	return run.Options{Env: env, Timeout: timeout}
}

// withNotifier is a platform with another notifier.
type withNotifier struct {
	Platform
	notifier notify.Notifier
}

func (w withNotifier) Notifier() notify.Notifier { return w.notifier }

// WithNotifier is p with n as its notifier.
func WithNotifier(p Platform, n notify.Notifier) Platform { return withNotifier{p, n} }

// New builds the platform for os. With notifications off the notifier only logs (MAJHI_HOST_NOTIFY=off).
func New(os string, deps sys.Deps, notifications bool) Platform {
	var p Platform
	switch os {
	case protocol.OSMacOS:
		p = NewMacOS(deps, NewMacNotifier(deps, TerminalNotifier, nil))
	case protocol.OSWSL:
		p = NewWSL(deps, WslPaths{})
	default:
		p = NewLinux(deps, nil)
	}
	return WithNotifier(p, notify.Desktop(notifications, p.Notifier(), deps.Log))
}
