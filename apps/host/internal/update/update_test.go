package update

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"majhi/host/internal/checkout"
	"majhi/host/internal/git"
	"majhi/host/internal/hostlog"
	"majhi/host/internal/protocol"
	"majhi/host/internal/run"
)

const head = "0123456789abcdef0123456789abcdef01234567"

// Image ids as Docker prints them.
// The override the update replaces: what gen-override makes, with a root inside the owner's home ("/h").
const oldMounts = "services:\n  server:\n    volumes:\n      - /h/Work:/h/Work\n"

var (
	server = "sha256:" + strings.Repeat("a", 64)
	runner = "sha256:" + strings.Repeat("b", 64)
	laya   = "sha256:" + strings.Repeat("c", 64)
)

type fakeDocker struct {
	mu    sync.Mutex
	calls []string
	// failOnce fails the first docker command that starts with this.
	failOnce   string
	failedOnce bool
	// netFails fails the build this many times with a network error first.
	netFails    int
	netFailed   int
	imageAbsent bool
}

func (f *fakeDocker) run(file string, args []string, o run.Options) run.Result {
	line := strings.Join(args, " ")
	if file != "/usr/bin/docker" {
		// git, in the checkout.
		rest := args[len(git.GuardConfig):]
		switch rest[0] {
		case "rev-parse":
			return run.Result{Stdout: head + "\n"}
		}
		return run.Result{}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, line)
	fail := func(stderr string) run.Result { return run.Result{Code: 1, Stderr: stderr} }
	if strings.HasPrefix(line, "compose --profile runner") && f.netFailed < f.netFails {
		f.netFailed++
		return fail(`failed to fetch oauth token: Post "https://auth.docker.io/token": net/http: TLS handshake timeout`)
	}
	if f.failOnce != "" && strings.HasPrefix(line, f.failOnce) && !f.failedOnce {
		f.failedOnce = true
		return fail("container majhi-server-1 is unhealthy")
	}
	switch {
	case strings.HasPrefix(line, "image inspect"):
		if f.imageAbsent {
			return fail("No such image")
		}
		switch {
		case strings.HasSuffix(line, "majhi-laya:dev"):
			return run.Result{Stdout: laya + "\n"}
		case strings.HasSuffix(line, "majhi-runner:dev"):
			return run.Result{Stdout: runner + "\n"}
		}
		return run.Result{Stdout: server + "\n"}
	case strings.HasPrefix(line, "container inspect"):
		return fail("No such container")
	case strings.HasPrefix(line, "compose logs"):
		return run.Result{Stdout: "server-1  | starting\nserver-1  | SqliteError: malformed JSON\n"}
	case strings.HasPrefix(line, "compose run"):
		return run.Result{Stdout: "services: {}\n"}
	case strings.HasPrefix(line, "run --rm") && strings.Contains(line, "gen-key"):
		return run.Result{Stdout: "AGE-SECRET-KEY-TEST\n"}
	case strings.HasPrefix(line, "create"):
		return run.Result{Stdout: "cid123\n"}
	case strings.HasPrefix(line, "cp"):
		_ = os.WriteFile(args[2], []byte("helper"), 0o600)
	}
	return run.Result{}
}

func (f *fakeDocker) docker() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.calls...)
}

func index(calls []string, line string) int {
	for i, c := range calls {
		if c == line {
			return i
		}
	}
	return -1
}

func lastIndex(calls []string, line string) int {
	at := -1
	for i, c := range calls {
		if c == line {
			at = i
		}
	}
	return at
}

type setup struct {
	dir, repo, home string
	docker          *fakeDocker
	exits           int
	options         Options
}

func newSetup(t *testing.T, docker *fakeDocker) *setup {
	t.Helper()
	dir := t.TempDir()
	s := &setup{dir: dir, repo: filepath.Join(dir, "repo"), home: filepath.Join(dir, "home"), docker: docker}
	for _, d := range []string{s.repo, s.home} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	key := filepath.Join(dir, "secrets", "secrets.key")
	if err := os.MkdirAll(filepath.Dir(key), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(key, []byte("existing"), 0o600); err != nil {
		t.Fatal(err)
	}
	remount := RemountOptions{Repo: s.repo, Docker: "/usr/bin/docker", Env: map[string]string{"HOME": "/h"}, Run: docker.run, Log: hostlog.Discard()}
	s.options = Options{
		Remount:   remount,
		Git:       checkout.Context{Git: "/usr/bin/git", Repo: s.repo, Env: map[string]string{}, Run: docker.run},
		MajhiHome: s.home, Bundle: filepath.Join(s.home, "bin", "majhi-host"), SelfPath: "/elsewhere/main",
		ImagePath: "/app/host/majhi-host-linux-arm64", SecretsKeyFile: key, Log: hostlog.Discard(),
		Exit:  func() { s.exits++ },
		Sleep: func(time.Duration) {},
	}
	return s
}

func (s *setup) status(t *testing.T) protocol.UpdateStatus {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(s.home, protocol.UpdateStatusFile))
	if err != nil {
		t.Fatal(err)
	}
	var status protocol.UpdateStatus
	if err := json.Unmarshal(data, &status); err != nil {
		t.Fatal(err)
	}
	return status
}

func (s *setup) runUpdate(t *testing.T) protocol.UpdateStatus {
	t.Helper()
	u := New(s.options)
	if !u.Start() {
		t.Fatal("an update was already running")
	}
	u.Wait()
	return s.status(t)
}

// If the new majhi does not start, the host goes back to the previous image and mounts, and says
// why (guarantee 54).
func TestUpdateGoesBackWhenTheNewMajhiDoesNotStart(t *testing.T) {
	docker := &fakeDocker{failOnce: "compose up"}
	s := newSetup(t, docker)
	s.options.SelfPath = s.options.Bundle
	if err := os.WriteFile(filepath.Join(s.repo, OverrideFile), []byte(oldMounts), 0o644); err != nil {
		t.Fatal(err)
	}
	status := s.runUpdate(t)
	if status.State != "failed" {
		t.Fatalf("state %q: %v", status.State, status.Lines)
	}
	if !strings.Contains(status.Error, "SqliteError: malformed JSON") {
		t.Fatalf("the reason is missing: %q", status.Error)
	}
	joined := strings.Join(status.Lines, "\n")
	for _, want := range []string{"The new majhi said: SqliteError: malformed JSON", "Went back to the previous version"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("missing %q in %v", want, status.Lines)
		}
	}
	calls := docker.docker()
	tagBack := index(calls, "tag "+server+" majhi-server:dev")
	firstUp := index(calls, "compose up -d --wait")
	if firstUp < 0 || tagBack < firstUp {
		t.Fatalf("the image was not tagged back after the failed start: %v", calls)
	}
	if lastIndex(calls, "compose up -d --wait") < tagBack {
		t.Fatalf("the previous majhi was not started: %v", calls)
	}
	if got, _ := os.ReadFile(filepath.Join(s.repo, OverrideFile)); string(got) != oldMounts {
		t.Fatalf("mounts %q", got)
	}
	if index(calls, "create majhi-server:dev") >= 0 {
		t.Fatal("the helper was replaced after a failed update")
	}
	if s.exits != 0 {
		t.Fatal("the helper exited after a failed update")
	}
	if journal, err := ReadJournal(s.home); journal != nil || err != nil {
		t.Fatalf("the journal was left: %+v %v", journal, err)
	}
}

func TestUpdateReplacesTheHelperAndExitsWhenItRunsFromTheBundle(t *testing.T) {
	docker := &fakeDocker{}
	s := newSetup(t, docker)
	s.options.SelfPath = s.options.Bundle
	status := s.runUpdate(t)
	if status.State != "done" || status.Error != "" {
		t.Fatalf("%+v", status)
	}
	if got, _ := os.ReadFile(s.options.Bundle); string(got) != "helper" {
		t.Fatalf("bundle %q", got)
	}
	info, _ := os.Stat(s.options.Bundle)
	if info.Mode().Perm() != 0o755 {
		t.Fatalf("mode %v", info.Mode())
	}
	if s.exits != 1 {
		t.Fatalf("exits %d", s.exits)
	}
	if journal, _ := ReadJournal(s.home); journal != nil {
		t.Fatal("the journal was left after a good update")
	}
}

func TestUpdateRetriesABuildThatFailedOnTheNetworkOnly(t *testing.T) {
	docker := &fakeDocker{netFails: 2}
	s := newSetup(t, docker)
	if status := s.runUpdate(t); status.State != "done" {
		t.Fatalf("%+v", status)
	}
	docker = &fakeDocker{netFails: 3}
	s = newSetup(t, docker)
	status := s.runUpdate(t)
	if status.State != "failed" || !strings.Contains(status.Error, "image registry could not be reached") {
		t.Fatalf("%+v", status)
	}
}

// An update cut off at any phase goes back from its journal when the helper starts again.
func TestAnInterruptedUpdateIsRecoveredAtStart(t *testing.T) {
	cases := []struct {
		phase    string
		stops    bool
		restores bool
		restarts bool
		reported string
	}{
		{PhasePrepared, false, false, false, "failed"},
		{PhaseSnapshotting, true, false, true, "failed"},
		{PhaseStarting, true, true, true, "failed"},
		{PhaseCommitted, false, false, false, "done"},
	}
	for _, c := range cases {
		t.Run(c.phase, func(t *testing.T) {
			docker := &fakeDocker{}
			s := newSetup(t, docker)
			mounts := oldMounts
			if err := WriteJournal(s.home, Journal{
				Version: 1, Phase: c.phase, Mounts: &mounts,
				Previous: []KeptImage{{Image: ServerImage, ID: server}},
			}); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(s.repo, OverrideFile), []byte("new mounts\n"), 0o644); err != nil {
				t.Fatal(err)
			}
			running, _ := json.Marshal(protocol.UpdateStatus{State: "running", Commit: head, StartedAt: "2026-10-21T00:00:00.000Z", Lines: []string{"Building"}})
			if err := os.WriteFile(filepath.Join(s.home, protocol.UpdateStatusFile), running, 0o644); err != nil {
				t.Fatal(err)
			}
			if err := RecoverUpdate(s.options, nil); err != nil {
				t.Fatal(err)
			}
			calls := docker.docker()
			has := func(prefix string) bool {
				for _, call := range calls {
					if strings.HasPrefix(call, prefix) {
						return true
					}
				}
				return false
			}
			if has("compose stop server") != c.stops {
				t.Fatalf("stop: %v", calls)
			}
			if has("run --rm --network none") && !c.restores || !has("run --rm --network none") && c.restores {
				t.Fatalf("database restore: %v", calls)
			}
			if c.phase != PhaseCommitted {
				if !has("tag " + server + " majhi-server:dev") {
					t.Fatalf("the previous image was not put back: %v", calls)
				}
				if got, _ := os.ReadFile(filepath.Join(s.repo, OverrideFile)); string(got) != mounts {
					t.Fatalf("mounts %q", got)
				}
			}
			if has("compose up -d --wait") != c.restarts {
				t.Fatalf("restart: %v", calls)
			}
			if journal, _ := ReadJournal(s.home); journal != nil {
				t.Fatal("the journal was left after recovery")
			}
			if got := s.status(t); got.State != c.reported {
				t.Fatalf("status %q, want %q", got.State, c.reported)
			}
		})
	}
}

// A recovery that fails leaves the journal, so the next start tries again.
func TestAFailedRecoveryKeepsTheJournal(t *testing.T) {
	docker := &fakeDocker{failOnce: "compose stop"}
	s := newSetup(t, docker)
	if err := WriteJournal(s.home, Journal{Version: 1, Phase: PhaseStarting, Previous: []KeptImage{{Image: ServerImage, ID: server}}}); err != nil {
		t.Fatal(err)
	}
	if err := RecoverUpdate(s.options, nil); err == nil {
		t.Fatal("recovery did not fail")
	}
	if journal, err := ReadJournal(s.home); journal == nil || err != nil {
		t.Fatalf("the journal is gone: %v", err)
	}
	if err := RecoverUpdate(s.options, nil); err != nil {
		t.Fatalf("the second try: %v", err)
	}
	if journal, _ := ReadJournal(s.home); journal != nil {
		t.Fatal("the journal was left")
	}
	_ = errors.New
}

// A journal on disk is acted on (images tagged, a checkout moved, a compose file written), so one that
// names a git option, an image id that is not a sha256 id, or a mount of the computer's root is kept
// aside and nothing runs.
func TestAPlantedJournalIsRefusedAndNothingRuns(t *testing.T) {
	mounts := func(source string) *string {
		text := "services:\n  server:\n    volumes:\n      - " + source + ":" + source + "\n"
		return &text
	}
	moved := func(head string) *checkout.Moved {
		return &checkout.Moved{From: "v1.0.0", To: "v1.1.0", Head: head, Dotenv: "MAJHI_VERSION=v1.0.0\n"}
	}
	cases := []struct {
		name string
		raw  func(home string) string
	}{
		{"a head that is a git option", func(string) string {
			return `{"version":1,"phase":"prepared","previous":[],"moved":{"from":"v1.0.0","to":"v1.1.0","head":"--upload-pack=x","dotenv":"a"}}`
		}},
		{"an image id that is not a sha256 id", func(string) string {
			return `{"version":1,"phase":"starting","previous":[{"image":"majhi-server:dev","id":"evil:latest"}]}`
		}},
		{"a moved release without a field", func(string) string {
			return `{"version":1,"phase":"prepared","previous":[],"moved":{"from":"","to":"v1.1.0","head":"` + head + `","dotenv":"a"}}`
		}},
		{"a mount of the computer's root", func(home string) string {
			data, _ := json.Marshal(Journal{Version: 1, Phase: PhaseStarting, Previous: []KeptImage{{Image: ServerImage, ID: server}}, Mounts: mounts("/")})
			return string(data)
		}},
		{"a mount of the Docker socket", func(home string) string {
			data, _ := json.Marshal(Journal{Version: 1, Phase: PhaseStarting, Previous: []KeptImage{{Image: ServerImage, ID: server}}, Mounts: mounts("/var/run/docker.sock")})
			return string(data)
		}},
		{"a mount outside the home", func(home string) string {
			data, _ := json.Marshal(Journal{Version: 1, Phase: PhaseStarting, Previous: []KeptImage{{Image: ServerImage, ID: server}}, Mounts: mounts("/opt/secrets")})
			return string(data)
		}},
		{"a mount that climbs out of the home", func(home string) string {
			data, _ := json.Marshal(Journal{Version: 1, Phase: PhaseStarting, Previous: []KeptImage{{Image: ServerImage, ID: server}}, Mounts: mounts(home + "/Work/../../etc")})
			return string(data)
		}},
		{"a privileged service in the saved mounts", func(home string) string {
			text := "services:\n  server:\n    privileged: true\n"
			data, _ := json.Marshal(Journal{Version: 1, Phase: PhaseStarting, Previous: []KeptImage{{Image: ServerImage, ID: server}}, Mounts: &text})
			return string(data)
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			docker := &fakeDocker{}
			s := newSetup(t, docker)
			s.options.Remount.Env["HOME"] = filepath.Join(s.dir, "owner")
			s.options.Now = func() time.Time { return time.Date(2026, 10, 21, 12, 0, 0, 0, time.UTC) }
			if err := os.WriteFile(filepath.Join(s.home, journalFile), []byte(c.raw(s.options.Remount.Env["HOME"])), 0o600); err != nil {
				t.Fatal(err)
			}
			override := filepath.Join(s.repo, OverrideFile)
			if err := os.WriteFile(override, []byte("current\n"), 0o644); err != nil {
				t.Fatal(err)
			}
			if err := RecoverUpdate(s.options, nil); err != nil {
				t.Fatal(err)
			}
			if calls := docker.docker(); len(calls) != 0 {
				t.Fatalf("something ran: %v", calls)
			}
			if got, _ := os.ReadFile(override); string(got) != "current\n" {
				t.Fatalf("the mounts were written: %q", got)
			}
			if journal, err := ReadJournal(s.home); journal != nil || err != nil {
				t.Fatalf("the journal is still in place: %v", err)
			}
			if _, err := os.Stat(filepath.Join(s.home, journalFile+".bad-20261021T120000Z")); err != nil {
				t.Fatalf("the journal was not kept aside: %v", err)
			}
		})
	}
	// A good journal with mounts in the home is still acted on.
	docker := &fakeDocker{}
	s := newSetup(t, docker)
	owner := filepath.Join(s.dir, "owner")
	s.options.Remount.Env["HOME"] = owner
	if err := WriteJournal(s.home, Journal{Version: 1, Phase: PhaseStarting, Previous: []KeptImage{{Image: ServerImage, ID: server}}, Mounts: mounts(owner + "/Work"), Moved: moved(head)}); err != nil {
		t.Fatal(err)
	}
	if err := RecoverUpdate(s.options, nil); err != nil {
		t.Fatal(err)
	}
	if index(docker.docker(), "tag "+server+" majhi-server:dev") < 0 {
		t.Fatalf("a good journal was not acted on: %v", docker.docker())
	}
	if got, _ := os.ReadFile(filepath.Join(s.repo, OverrideFile)); !strings.Contains(string(got), owner+"/Work") {
		t.Fatalf("mounts %q", got)
	}
}
