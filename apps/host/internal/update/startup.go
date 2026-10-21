package update

import (
	"fmt"
	"strings"
	"time"

	"majhi/host/internal/hostlog"
	"majhi/host/internal/platform"
)

// The start-at-login flow: make sure Docker is up, then that majhi is running.

const (
	// DockerWait is how long the helper waits for Docker to come up after starting it.
	DockerWait = 120 * time.Second
	// DockerPoll is how often it looks while it waits.
	DockerPoll = 5 * time.Second
	// RetryDelay is how long a failed start waits before the next try, never sooner.
	RetryDelay  = 60 * time.Second
	MaxAttempts = 3
)

// StartupOutcome is what one pass did.
type StartupOutcome struct {
	OK      bool
	Steps   []string
	Step    string
	Message string
}

// StartupDeps is everything the start-at-login flow touches, so tests run it with fakes and never touch Docker.
type StartupDeps struct {
	Log hostlog.Logger
	// DockerUp is true when `docker info` succeeds.
	DockerUp func() bool
	// Docker starts Docker where the helper can, and names the step the owner must take where it cannot.
	Docker platform.DockerPlatform
	// MajhiRunning is true when majhi's server container is running.
	MajhiRunning func() bool
	// StartMajhi is `docker compose up -d --wait` in the checkout. It fails with the reason.
	StartMajhi func() error
	// Notify is a desktop notification with the one step the owner must take.
	Notify func(message string)
	Sleep  func(time.Duration)
	Now    func() time.Time
}

// EnsureMajhiRunning is one pass: make sure Docker is up, then that majhi is running. It logs each
// step and returns what happened. It waits for Docker with a poll every few seconds, never in a tight loop.
func EnsureMajhiRunning(d StartupDeps) StartupOutcome {
	var steps []string
	say := func(text string) {
		steps = append(steps, text)
		d.Log("startup: " + text)
	}
	if !d.DockerUp() {
		say("Docker is not running")
		if !d.Docker.Start() {
			return StartupOutcome{Step: "open Docker", Message: d.Docker.Help(platform.NotStarted)}
		}
		say("opened Docker, waiting for it")
		deadline := d.Now().Add(DockerWait)
		up := false
		for d.Now().Before(deadline) {
			d.Sleep(DockerPoll)
			if d.DockerUp() {
				up = true
				break
			}
		}
		if !up {
			return StartupOutcome{Step: "wait for Docker", Message: d.Docker.Help(platform.Slow)}
		}
		say("Docker is up")
	} else {
		say("Docker is up")
	}
	if d.MajhiRunning() {
		say("majhi is already running")
		return StartupOutcome{OK: true, Steps: steps}
	}
	say("majhi is not running, starting it")
	if err := d.StartMajhi(); err != nil {
		reason, _, _ := strings.Cut(err.Error(), "\n")
		d.Log("startup: could not start majhi: " + reason)
		return StartupOutcome{Step: "start majhi", Message: "majhi could not start. Open a terminal in the majhi folder and run make up."}
	}
	say("majhi is running")
	return StartupOutcome{OK: true, Steps: steps}
}

// StartAtLogin runs EnsureMajhiRunning up to three times, a minute apart, and posts a notification
// only when the last attempt still fails, so the owner hears about it once.
func StartAtLogin(d StartupDeps) StartupOutcome {
	outcome := EnsureMajhiRunning(d)
	for attempt := 1; !outcome.OK && attempt < MaxAttempts; attempt++ {
		d.Log(fmt.Sprintf("startup: %s failed, trying again in %ds", outcome.Step, int(RetryDelay.Seconds())))
		d.Sleep(RetryDelay)
		outcome = EnsureMajhiRunning(d)
	}
	if !outcome.OK {
		d.Log(fmt.Sprintf("startup: giving up at %q", outcome.Step))
		d.Notify(outcome.Message)
	}
	return outcome
}
