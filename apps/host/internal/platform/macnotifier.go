package platform

import (
	"sync"
	"time"

	"majhi/host/internal/notify"
	"majhi/host/internal/run"
	"majhi/host/internal/sys"
)

// macOS notifications. majhi's own notifier app (named majhi, with the majhi icon, a click opens the
// page) is preferred; terminal-notifier is the fallback where it cannot be built. osascript is never
// used: macOS shows its notifications as Script Editor's, and a click opens Script Editor.
//
// The result comes from the program's exit code, never from its message: 0 shown, 3 notifications are
// off for it in System Settings, anything else failed. When they are off the helper shows nothing
// and says `blocked`, so the app can ask the owner for the one step that fixes it.

const (
	notifyRun = 10 * time.Second
	// askTimeout: macOS asks the owner for permission at the first notification, and a program that
	// is ended while the question is on screen counts as a No, for good. So a question never runs
	// under the short timeout: majhi's app is asked with `authorize` and this long wait, and
	// terminal-notifier, which asks inside its first post, gets it until its first success.
	askTimeout  = 24 * time.Hour
	settingsURL = "x-apple.systempreferences:com.apple.Notifications-Settings.extension"
	// buildWait: a notification waits this long for a build that is under way, then is not shown.
	buildWait = 8 * time.Second
)

type macProgram struct {
	majhi bool
	path  string
}

// MacNotifier shows notifications on macOS.
type MacNotifier struct {
	deps sys.Deps
	tn   *tnFinder
	now  func() time.Time

	mu          sync.Mutex
	building    chan struct{}
	retryAt     time.Time
	unsupported bool
	shownOnce   bool
	asking      bool
}

// NewMacNotifier builds the notifier. release is the terminal-notifier release to fall back to.
func NewMacNotifier(deps sys.Deps, release NotifierRelease, now func() time.Time) *MacNotifier {
	if now == nil {
		now = time.Now
	}
	return &MacNotifier{deps: deps, tn: &tnFinder{deps: deps, release: release, now: now}, now: now}
}

func argsFor(p macProgram, r notify.Request) []string {
	if p.majhi {
		args := []string{"post", "--title", r.Title, "--message", r.Message}
		if r.URL != "" {
			args = append(args, "--url", r.URL)
		}
		if r.Sound {
			args = append(args, "--sound")
		}
		return args
	}
	args := []string{"-title", r.Title, "-message", r.Message, "-group", "majhi"}
	if r.URL != "" {
		args = append(args, "-open", r.URL)
	}
	if r.Sound {
		args = append(args, "-sound", "Glass")
	}
	return args
}

// build starts a build unless one runs, or none can run. It returns what to wait on, or nil.
func (n *MacNotifier) build() chan struct{} {
	n.mu.Lock()
	defer n.mu.Unlock()
	if n.building != nil {
		return n.building
	}
	if n.unsupported || n.now().Before(n.retryAt) {
		return nil
	}
	n.deps.Log("notify: building majhi's own notifier so notifications show as majhi")
	done := make(chan struct{})
	n.building = done
	go func() {
		result := buildNotifier(n.deps)
		n.mu.Lock()
		switch result {
		case buildUnsupported:
			n.unsupported = true
		case buildFailed:
			n.retryAt = n.now().Add(buildRetry)
		}
		n.building = nil
		n.mu.Unlock()
		close(done)
	}()
	return done
}

func (n *MacNotifier) isBuilding() bool {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.building != nil
}

func within(done chan struct{}, d time.Duration) {
	select {
	case <-done:
	case <-time.After(d):
	}
}

// find is the program to use now, or false while nothing is ready.
func (n *MacNotifier) find() (macProgram, bool) {
	own := notifierProgram(n.deps.MajhiHome)
	if n.deps.Exists(own) {
		// An app from an older helper keeps working while a newer one is built.
		if !notifierIsCurrent(n.deps.MajhiHome) {
			n.build()
		}
		return macProgram{majhi: true, path: own}, true
	}
	if pending := n.build(); pending != nil {
		within(pending, buildWait)
		if n.deps.Exists(own) {
			return macProgram{majhi: true, path: own}, true
		}
		// Still building: nothing is shown for these seconds, and Prepare at start avoids them.
		if n.isBuilding() {
			return macProgram{}, false
		}
	}
	if fallback := n.tn.find(); fallback != "" {
		return macProgram{path: fallback}, true
	}
	return macProgram{}, false
}

// ask asks the owner for permission, once at a time, without waiting for the answer. A Yes shows
// later as a notification that works; a No stays what it is until the owner changes it in Settings.
func (n *MacNotifier) ask(p macProgram) {
	n.mu.Lock()
	if n.asking || !p.majhi {
		n.mu.Unlock()
		return
	}
	n.asking = true
	n.mu.Unlock()
	n.deps.Log("notify: asking macOS to allow notifications for majhi")
	go func() {
		done := n.deps.Run(p.path, []string{"authorize"}, run.Options{Env: map[string]string{"PATH": n.deps.Path}, Timeout: askTimeout})
		n.deps.Log("notify: macOS answered the notification question (exit " + exitText(done.Code) + ")")
		n.mu.Lock()
		n.asking = false
		n.mu.Unlock()
	}()
}

func exitText(code int) string {
	if code == run.NoCode {
		return "null"
	}
	return itoa(code)
}

// Prepare builds or installs the notifier now, so the first notification is not lost.
func (n *MacNotifier) Prepare() error {
	// Waits for a build, then a failed or impossible one leaves terminal-notifier to install.
	n.find()
	if n.isBuilding() {
		n.mu.Lock()
		done := n.building
		n.mu.Unlock()
		if done != nil {
			<-done
		}
		n.find()
	}
	// The question comes now, while the owner is likely at the Mac, not at the first alert.
	program, ok := n.find()
	if !ok || !program.majhi {
		return nil
	}
	status := n.deps.Run(program.path, []string{"status"}, run.Options{Env: map[string]string{"PATH": n.deps.Path}, Timeout: notifyRun})
	if status.Code == NotifierNotAskedCode {
		n.ask(program)
	}
	return nil
}

// Show shows one notification.
func (n *MacNotifier) Show(r notify.Request) (notify.Outcome, error) {
	program, ok := n.find()
	if !ok {
		return notify.Outcome{Kind: notify.Unavailable}, nil
	}
	n.mu.Lock()
	timeout := notifyRun
	if !program.majhi && !n.shownOnce {
		timeout = askTimeout
	}
	n.mu.Unlock()
	done := n.deps.Run(program.path, argsFor(program, r), run.Options{Env: map[string]string{"PATH": n.deps.Path}, Timeout: timeout})
	switch done.Code {
	case 0:
		n.mu.Lock()
		n.shownOnce = true
		n.mu.Unlock()
		return notify.Outcome{Kind: notify.Shown, Clickable: r.URL != ""}, nil
	case NotifierOffCode:
		return notify.Outcome{Kind: notify.Blocked}, nil
	case NotifierNotAskedCode:
		// The owner has not answered the question yet: it is asked now, and until they say Yes it is off.
		n.ask(program)
		return notify.Outcome{Kind: notify.Blocked}, nil
	}
	return notify.Outcome{Kind: notify.Failed, Error: "macOS did not show the notification."}, nil
}

// OpenSettings opens System Settings at Notifications.
func (n *MacNotifier) OpenSettings() bool {
	done := n.deps.Run(openBin, []string{settingsURL}, run.Options{Env: map[string]string{"PATH": n.deps.Path, "HOME": n.deps.Home}, Timeout: notifyRun})
	return done.Code == 0
}
