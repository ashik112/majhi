// Package laya runs Laya on this Mac: a private venv with `laya-mlx`, its model, and a small Python
// service the helper starts on the first question. The server never talks to it; it sends `decide` jobs.
package laya

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"majhi/host/internal/hostlog"
	"majhi/host/internal/protocol"
	"majhi/host/internal/run"
)

const (
	// Version is the laya-mlx release majhi installs.
	Version = "0.2.0"
	// Model is the checkpoint it loads.
	Model = "aac6fef/laya-mlx"
	// IdleSeconds: the model unloads itself after this long without a question.
	IdleSeconds = 600
	// minDarwin: macOS 14 is Darwin 23.
	minDarwin    = 23
	serviceStart = 20 * time.Second
	// predictTimeout: the first question loads the model, which takes a few seconds.
	predictTimeout = 25 * time.Second
	venvTimeout    = 120 * time.Second
	pipTimeout     = 900 * time.Second
	probeTimeout   = 10 * time.Second
)

// Options are what Laya needs.
type Options struct {
	// MajhiHome is `~/.majhi`. Everything of Laya lives in `<MajhiHome>/laya`.
	MajhiHome string
	// Home is the owner's home, for finding Python.
	Home string
	// Path is the helper's PATH, already extended with the usual tool folders.
	Path string
	// GOOS and Arch default to the running system's.
	GOOS, Arch string
	// OSRelease is the kernel release, `uname -r` (Darwin 25.6.0 on macOS 26).
	OSRelease string
	Run       run.Func
	// Source is layad.py.
	Source string
	// Spawn starts a child whose output is read line by line. Nil: a real one.
	Spawn func(file string, args []string, env map[string]string) Proc
	HTTP  *http.Client
	Log   hostlog.Logger
	Now   func() time.Time
}

// Proc is a child process whose output is read line by line. It starts with Start, after the
// listeners are in place, so no line is lost.
type Proc interface {
	OnLine(listener func(stream string, line string))
	OnExit(listener func(code int))
	Start()
	Kill()
}

// Laya is the native Laya on this Mac.
type Laya struct {
	o       Options
	dir     string
	python  string
	script  string
	install string

	mu         sync.Mutex
	status     protocol.LayaStatus
	installing chan struct{}
	service    *service
	starting   chan struct{}
	startErr   error
	lastUsed   time.Time
	// noPython is true after an install found no Python: the owner may install one and try again.
	noPython bool
}

type service struct {
	proc  Proc
	port  int
	token string
}

// New builds Laya for this computer. It looks for an earlier install once.
func New(o Options) *Laya {
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Spawn == nil {
		o.Spawn = spawnReal
	}
	if o.HTTP == nil {
		o.HTTP = http.DefaultClient
	}
	dir := filepath.Join(o.MajhiHome, "laya")
	l := &Laya{
		o: o, dir: dir,
		python:  filepath.Join(dir, "venv", "bin", "python"),
		script:  filepath.Join(dir, "layad.py"),
		install: filepath.Join(dir, "installed.json"),
	}
	darwin, _ := strconv.Atoi(strings.SplitN(o.OSRelease, ".", 2)[0])
	switch {
	case o.GOOS != "darwin" || o.Arch != "arm64":
		l.status = protocol.LayaStatus{State: protocol.LayaUnsupported, Detail: "Laya needs a Mac with Apple silicon."}
	case darwin < minDarwin:
		l.status = protocol.LayaStatus{State: protocol.LayaUnsupported, Detail: "Laya needs macOS 14 or newer."}
	default:
		l.status = protocol.LayaStatus{State: protocol.LayaNotInstalled}
		// Look for an earlier install once, without waiting.
		if data, err := os.ReadFile(l.install); err == nil {
			var raw map[string]string
			if json.Unmarshal(data, &raw) == nil && raw["version"] != "" && raw["model"] != "" && raw["installedAt"] != "" {
				l.status = protocol.LayaStatus{State: protocol.LayaReady, Version: raw["version"]}
			}
		}
	}
	return l
}

func (l *Laya) set(next protocol.LayaStatus) {
	l.mu.Lock()
	l.status = next
	l.mu.Unlock()
}

func (l *Laya) env(extra map[string]string) map[string]string {
	// Only what Python needs. Nothing from majhi's own environment.
	env := map[string]string{
		"PATH": l.o.Path, "HOME": l.o.Home, "LANG": "en_US.UTF-8",
		"HF_HOME": filepath.Join(l.dir, "hf"), "HF_HUB_DISABLE_TELEMETRY": "1",
	}
	for k, v := range extra {
		env[k] = v
	}
	return env
}

// Status is Laya's state now.
func (l *Laya) Status() protocol.LayaStatus {
	l.mu.Lock()
	defer l.mu.Unlock()
	// The service unloads the model on its own after the idle time.
	if l.status.State == protocol.LayaLoaded && l.o.Now().Sub(l.lastUsed) > time.Duration(IdleSeconds)*time.Second+10*time.Second {
		l.status = protocol.LayaStatus{State: protocol.LayaReady, Version: l.versionLocked()}
	}
	return l.status
}

func (l *Laya) versionLocked() string {
	if l.status.Version != "" {
		return l.status.Version
	}
	return Version
}

func (l *Laya) findPython() string {
	names := []string{"python3.14", "python3.13", "python3.12", "python3.11", "python3"}
	var dirs []string
	for _, d := range strings.Split(l.o.Path, ":") {
		if d != "" {
			dirs = append(dirs, d)
		}
	}
	dirs = append(dirs, filepath.Join(l.o.Home, ".pyenv", "shims"), filepath.Join(l.o.Home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin")
	seen := map[string]bool{}
	for _, name := range names {
		for _, d := range dirs {
			file := filepath.Join(d, name)
			if seen[file] {
				continue
			}
			seen[file] = true
			result := l.o.Run(file, []string{"-c", "import sys; print('%d.%d' % sys.version_info[:2])"}, run.Options{Env: l.env(nil), Timeout: probeTimeout})
			major, minor, ok := parseVersion(strings.TrimSpace(result.Stdout))
			if result.Code != 0 || !ok {
				continue
			}
			if major > 3 || (major == 3 && minor >= 11) {
				return file
			}
		}
	}
	return ""
}

func parseVersion(text string) (major, minor int, ok bool) {
	a, b, found := strings.Cut(text, ".")
	if !found {
		return 0, 0, false
	}
	minorDigits := b
	for i, r := range b {
		if r < '0' || r > '9' {
			minorDigits = b[:i]
			break
		}
	}
	major, errA := strconv.Atoi(a)
	minor, errB := strconv.Atoi(minorDigits)
	return major, minor, errA == nil && errB == nil
}

func (l *Laya) writeScript() error {
	if current, err := os.ReadFile(l.script); err == nil && string(current) == l.o.Source {
		return nil
	}
	if err := os.MkdirAll(l.dir, 0o755); err != nil {
		return err
	}
	return os.WriteFile(l.script, []byte(l.o.Source), 0o600)
}

func lastLine(text string) string {
	lines := strings.Split(strings.TrimSpace(text), "\n")
	line := lines[len(lines)-1]
	if len(line) > 200 {
		line = line[:200]
	}
	if line == "" {
		return "no details"
	}
	return line
}

func (l *Laya) runInstall() {
	fail := func(err error) {
		l.o.Log("laya: install failed: " + err.Error())
		l.set(protocol.LayaStatus{State: protocol.LayaError, Detail: err.Error()})
	}
	l.set(protocol.LayaStatus{State: protocol.LayaInstalling, Detail: "Looking for Python"})
	python := l.findPython()
	if python == "" {
		l.mu.Lock()
		l.noPython = true
		l.mu.Unlock()
		l.set(protocol.LayaStatus{State: protocol.LayaUnsupported, Detail: "Laya needs Python 3.11 or newer, and none was found on this Mac."})
		return
	}
	if err := os.MkdirAll(l.dir, 0o755); err != nil {
		fail(err)
		return
	}
	l.set(protocol.LayaStatus{State: protocol.LayaInstalling, Detail: "Creating a private Python environment"})
	if l.o.Run(python, []string{"-m", "venv", filepath.Join(l.dir, "venv")}, run.Options{Env: l.env(nil), Timeout: venvTimeout}).Code != 0 {
		fail(errors.New("Could not create the Python environment."))
		return
	}
	l.set(protocol.LayaStatus{State: protocol.LayaInstalling, Detail: "Installing laya-mlx " + Version})
	pip := l.o.Run(l.python, []string{"-m", "pip", "install", "--disable-pip-version-check", "--quiet", "laya-mlx==" + Version}, run.Options{Env: l.env(nil), Timeout: pipTimeout})
	if pip.Code != 0 {
		fail(fmt.Errorf("pip could not install laya-mlx: %s", lastLine(pip.Stderr)))
		return
	}
	if err := l.writeScript(); err != nil {
		fail(err)
		return
	}
	if err := l.download(); err != nil {
		fail(err)
		return
	}
	record, _ := json.Marshal(map[string]string{"version": Version, "model": Model, "installedAt": l.o.Now().UTC().Format("2006-01-02T15:04:05.000Z")})
	if err := os.WriteFile(l.install, record, 0o644); err != nil {
		fail(err)
		return
	}
	l.set(protocol.LayaStatus{State: protocol.LayaReady, Version: Version})
	l.o.Log("laya: installed " + Version)
}

func (l *Laya) download() error {
	const detail = "Downloading the model, about 850 MB"
	zero := 0.0
	l.set(protocol.LayaStatus{State: protocol.LayaDownloading, Detail: detail, Progress: &zero})
	proc := l.o.Spawn(l.python, []string{l.script, "download"}, l.env(map[string]string{"MAJHI_LAYA_MODEL": Model}))
	var mu sync.Mutex
	finished, tail := false, ""
	exit := make(chan int, 1)
	proc.OnLine(func(stream, line string) {
		mu.Lock()
		defer mu.Unlock()
		if stream == "err" {
			if len(line) > 200 {
				line = line[len(line)-200:]
			}
			tail = line
			return
		}
		var parsed struct {
			Progress *float64 `json:"progress"`
			Done     *bool    `json:"done"`
		}
		if json.Unmarshal([]byte(line), &parsed) != nil {
			return
		}
		if parsed.Done != nil && *parsed.Done {
			finished = true
		} else if parsed.Progress != nil {
			p := min(1, *parsed.Progress)
			l.set(protocol.LayaStatus{State: protocol.LayaDownloading, Detail: detail, Progress: &p})
		}
	})
	proc.OnExit(func(code int) { exit <- code })
	proc.Start()
	code := <-exit
	mu.Lock()
	defer mu.Unlock()
	if code == 0 && finished {
		return nil
	}
	if tail == "" {
		return errors.New("The model download failed.")
	}
	return fmt.Errorf("The model download failed: %s", tail)
}

// Install starts the install if there is none running, and returns the state at once.
func (l *Laya) Install() protocol.LayaStatus {
	l.mu.Lock()
	canStart := l.installing == nil && (l.status.State == protocol.LayaNotInstalled || l.status.State == protocol.LayaError || l.noPython)
	if canStart {
		l.noPython = false
		done := make(chan struct{})
		l.installing = done
		go func() {
			l.runInstall()
			l.mu.Lock()
			l.installing = nil
			l.mu.Unlock()
			close(done)
		}()
	}
	status := l.status
	l.mu.Unlock()
	return status
}

// Settled waits for a running install. For tests.
func (l *Laya) Settled() {
	l.mu.Lock()
	done := l.installing
	l.mu.Unlock()
	if done != nil {
		<-done
	}
}

func (l *Laya) startService() (*service, error) {
	l.mu.Lock()
	if l.service != nil {
		defer l.mu.Unlock()
		return l.service, nil
	}
	if l.starting != nil {
		wait := l.starting
		l.mu.Unlock()
		<-wait
		l.mu.Lock()
		defer l.mu.Unlock()
		return l.service, l.startErr
	}
	done := make(chan struct{})
	l.starting = done
	l.mu.Unlock()

	svc, err := l.launch()

	l.mu.Lock()
	l.service, l.startErr = svc, err
	l.starting = nil
	l.mu.Unlock()
	close(done)
	return svc, err
}

func (l *Laya) launch() (*service, error) {
	raw := make([]byte, 24)
	if _, err := rand.Read(raw); err != nil {
		return nil, err
	}
	token := hex.EncodeToString(raw)
	proc := l.o.Spawn(l.python, []string{l.script, "serve"}, l.env(map[string]string{
		"MAJHI_LAYA_TOKEN": token, "MAJHI_LAYA_MODEL": Model, "MAJHI_LAYA_IDLE_SECONDS": strconv.Itoa(IdleSeconds),
	}))
	type ready struct {
		port int
		err  error
	}
	result := make(chan ready, 1)
	var mu sync.Mutex
	isReady, tail := false, ""
	var created *service
	proc.OnLine(func(stream, line string) {
		mu.Lock()
		defer mu.Unlock()
		if stream == "err" {
			if len(line) > 200 {
				line = line[len(line)-200:]
			}
			tail = line
			return
		}
		var parsed struct {
			Ready *bool `json:"ready"`
			Port  int   `json:"port"`
		}
		if json.Unmarshal([]byte(line), &parsed) != nil || parsed.Ready == nil || !*parsed.Ready || parsed.Port <= 0 || isReady {
			return
		}
		isReady = true
		created = &service{proc: proc, port: parsed.Port, token: token}
		result <- ready{port: parsed.Port}
	})
	proc.OnExit(func(code int) {
		mu.Lock()
		wasReady, text := isReady, tail
		mu.Unlock()
		l.mu.Lock()
		if l.service != nil && l.service.proc == proc {
			l.service = nil
		}
		if wasReady && l.status.State == protocol.LayaLoaded {
			l.status = protocol.LayaStatus{State: protocol.LayaReady, Version: l.versionLocked()}
		}
		l.mu.Unlock()
		if !wasReady {
			extra := ""
			if text != "" {
				extra = ": " + text
			}
			result <- ready{err: fmt.Errorf("The Laya service stopped (%s)%s", exitText(code), extra)}
		}
	})
	proc.Start()
	select {
	case r := <-result:
		if r.err != nil {
			return nil, r.err
		}
		mu.Lock()
		defer mu.Unlock()
		return created, nil
	case <-time.After(serviceStart):
		proc.Kill()
		return nil, errors.New("The Laya service did not start in time.")
	}
}

func exitText(code int) string {
	if code == run.NoCode {
		return "no code"
	}
	return strconv.Itoa(code)
}

// Decide asks Laya typed questions. It loads the model on the first call.
func (l *Laya) Decide(params protocol.DecideParams) (protocol.LayaDecideResult, error) {
	l.mu.Lock()
	status := l.status
	l.mu.Unlock()
	if status.State != protocol.LayaReady && status.State != protocol.LayaLoaded {
		if status.Detail != "" {
			return protocol.LayaDecideResult{}, errors.New(status.Detail)
		}
		return protocol.LayaDecideResult{}, errors.New("Laya is not installed yet.")
	}
	if err := l.writeScript(); err != nil {
		return protocol.LayaDecideResult{}, err
	}
	svc, err := l.startService()
	if err != nil {
		return protocol.LayaDecideResult{}, err
	}
	body, err := json.Marshal(params)
	if err != nil {
		return protocol.LayaDecideResult{}, err
	}
	req, err := http.NewRequest(http.MethodPost, fmt.Sprintf("http://127.0.0.1:%d/predict", svc.port), bytes.NewReader(body))
	if err != nil {
		return protocol.LayaDecideResult{}, err
	}
	req.Header.Set("Authorization", "Bearer "+svc.token)
	req.Header.Set("Content-Type", "application/json")
	client := *l.o.HTTP
	client.Timeout = predictTimeout
	res, err := client.Do(req)
	if err != nil {
		return protocol.LayaDecideResult{}, fmt.Errorf("Laya did not answer: %w", err)
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if res.StatusCode < 200 || res.StatusCode > 299 {
		var failure struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(data, &failure) == nil && failure.Error != "" {
			return protocol.LayaDecideResult{}, errors.New(failure.Error)
		}
		return protocol.LayaDecideResult{}, fmt.Errorf("Laya answered %d.", res.StatusCode)
	}
	var result protocol.LayaDecideResult
	if err := json.Unmarshal(data, &result); err != nil || !validResult(result) {
		return protocol.LayaDecideResult{}, errors.New("Laya sent an answer majhi could not read.")
	}
	l.mu.Lock()
	l.lastUsed = l.o.Now()
	l.status = protocol.LayaStatus{State: protocol.LayaLoaded, Version: l.versionLocked()}
	l.mu.Unlock()
	return result, nil
}

func validResult(r protocol.LayaDecideResult) bool {
	if r.Answers == nil || r.LoadMs < 0 || r.PredictMs < 0 {
		return false
	}
	for _, a := range r.Answers {
		if a.Type != "choice" && a.Type != "score" && a.Type != "noul" {
			return false
		}
		if a.Confidence < 0 || a.Confidence > 1 {
			return false
		}
		if a.Noul != nil && (*a.Noul < 0 || *a.Noul > 1) {
			return false
		}
	}
	return true
}

// Stop ends the service.
func (l *Laya) Stop() {
	l.mu.Lock()
	svc := l.service
	l.service = nil
	l.mu.Unlock()
	if svc != nil {
		svc.proc.Kill()
	}
}

// realProc is a child in its own process group, so killing it takes its children too.
type realProc struct {
	file string
	args []string
	env  map[string]string

	mu       sync.Mutex
	lines    []func(stream string, line string)
	exits    []func(code int)
	proc     *run.Proc
	finished bool
	code     int
}

func spawnReal(file string, args []string, env map[string]string) Proc {
	return &realProc{file: file, args: args, env: env}
}

func (p *realProc) Start() {
	splitter := func(stream string) func([]byte) {
		rest := ""
		return func(chunk []byte) {
			text := rest + string(chunk)
			start := 0
			for i := 0; i < len(text); i++ {
				if text[i] != '\r' && text[i] != '\n' {
					continue
				}
				if line := text[start:i]; line != "" {
					p.emit(stream, line)
				}
				start = i + 1
			}
			rest = text[start:]
		}
	}
	proc := run.Spawn(run.SpawnOptions{File: p.file, Args: p.args, Env: p.env, OnStdout: splitter("out"), OnStderr: splitter("err")})
	p.mu.Lock()
	p.proc = proc
	p.mu.Unlock()
	go func() {
		code := proc.Wait()
		p.mu.Lock()
		p.finished, p.code = true, code
		exits := append([]func(int){}, p.exits...)
		p.mu.Unlock()
		for _, f := range exits {
			f(code)
		}
	}()
}

func (p *realProc) emit(stream, line string) {
	p.mu.Lock()
	listeners := append([]func(string, string){}, p.lines...)
	p.mu.Unlock()
	for _, f := range listeners {
		f(stream, line)
	}
}

func (p *realProc) OnLine(f func(stream, line string)) {
	p.mu.Lock()
	p.lines = append(p.lines, f)
	p.mu.Unlock()
}

func (p *realProc) OnExit(f func(code int)) {
	p.mu.Lock()
	p.exits = append(p.exits, f)
	p.mu.Unlock()
}

func (p *realProc) Kill() {
	p.mu.Lock()
	proc := p.proc
	p.mu.Unlock()
	if proc != nil {
		proc.TerminateThenKill(5 * time.Second)
	}
}
