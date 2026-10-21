// Command contract is the helper over a fake platform, for the contract test (apps/server/src/host/
// contract.test.ts). It is the real client, jobs and handlers, with an in-memory keyring, a fake SSH
// agent, a fake notifier and fake editor, browser, clipboard and Docker starter, so no job touches the
// computer's keyring, desktop or Docker. Programs the helper runs (git, ssh, docker, gh, vercel) are
// found on the PATH the test sets, where the test puts its own stand-ins. It is built for the test only
// and never shipped.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	"majhi/host/internal/app"
	"majhi/host/internal/clitools"
	"majhi/host/internal/config"
	"majhi/host/internal/hostlog"
	"majhi/host/internal/notify"
	"majhi/host/internal/platform"
	"majhi/host/internal/protocol"
	"majhi/host/internal/sys"
)

type fakeKeyring struct {
	mu    sync.Mutex
	items map[string]string
}

func (k *fakeKeyring) Check() protocol.KeyringState {
	return protocol.KeyringState{Kind: protocol.KeyringKeychain}
}

func (k *fakeKeyring) Read(item platform.KeyringItem) (string, bool, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	v, ok := k.items[item.Service+"|"+item.Account]
	return v, ok, nil
}

func (k *fakeKeyring) Write(item platform.KeyringItem, secret string) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	k.items[item.Service+"|"+item.Account] = secret
	return nil
}

func (k *fakeKeyring) Remove(item platform.KeyringItem) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	delete(k.items, item.Service+"|"+item.Account)
	return nil
}

type fakeAgent struct{}

func (fakeAgent) Socket() string                { return "/fake/agent.sock" }
func (fakeAgent) Passphrases() platform.Keeping { return platform.KeepNone }
func (fakeAgent) ComposeSocket() string         { return "/fake/compose.sock" }
func (fakeAgent) Serve() func()                 { return func() {} }

type fakeNotifier struct{}

func (fakeNotifier) Show(r notify.Request) (notify.Outcome, error) {
	return notify.Outcome{Kind: notify.Shown, Clickable: r.URL != ""}, nil
}
func (fakeNotifier) OpenSettings() bool { return true }

type fakeEditor struct{}

func (fakeEditor) CLICandidates(string) []string       { return nil }
func (fakeEditor) OpenApp(string, string) (bool, bool) { return true, true }

type fakeDocker struct{}

func (fakeDocker) Start() bool                           { return true }
func (fakeDocker) Help(platform.DockerHelpReason) string { return "Open Docker." }

type fakePlatform struct {
	keyring *fakeKeyring
	env     map[string]string
}

func (p *fakePlatform) OS() string                      { return protocol.OSMacOS }
func (p *fakePlatform) Keyring() platform.Keyring       { return p.keyring }
func (p *fakePlatform) SSHAgent() platform.SSHAgent     { return fakeAgent{} }
func (p *fakePlatform) Notifier() notify.Notifier       { return fakeNotifier{} }
func (p *fakePlatform) Editor() platform.EditorPlatform { return fakeEditor{} }
func (p *fakePlatform) Docker() platform.DockerPlatform { return fakeDocker{} }
func (p *fakePlatform) SkippedAtHome() map[string]bool  { return map[string]bool{"Library": true} }
func (p *fakePlatform) DesktopEnv() map[string]string   { return p.env }
func (p *fakePlatform) OpenURL(url string) bool         { return strings.HasPrefix(url, "http") }
func (p *fakePlatform) ClipboardCopy(text string) bool  { return text != "" }

func main() {
	if len(os.Args) > 1 && os.Args[1] == "--cli-tools" {
		dumpTools()
		return
	}
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "contract helper failed:", err)
		os.Exit(1)
	}
}

func run() error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	env := map[string]string{}
	for _, e := range os.Environ() {
		if k, v, ok := strings.Cut(e, "="); ok {
			env[k] = v
		}
	}
	cfg, err := config.Parse(env, home)
	if err != nil {
		return err
	}
	log, err := hostlog.NewFile(filepath.Join(cfg.MajhiHome, "logs", "host.log"), hostlog.MaxBytes)
	if err != nil {
		return err
	}
	deps := sys.Real(env, protocol.OSMacOS, cfg.Home, cfg.MajhiHome, log, false)
	plat := &fakePlatform{keyring: &fakeKeyring{items: map[string]string{}}, env: map[string]string{"PATH": deps.Path, "HOME": cfg.Home}}
	exited := make(chan int, 1)
	instance, err := app.New(app.Options{
		Config: cfg, Platform: plat, Deps: deps, UID: os.Getuid(), GID: os.Getgid(),
		Exit: func(code int) {
			select {
			case exited <- code:
			default:
			}
		},
		// Laya believes it is on an Apple silicon Mac, so `decide` runs against the test's fake service.
		OSRelease: "25.0.0", GOOS: "darwin", Arch: "arm64",
		ImagePath: "/app/host/majhi-host-" + runtime.GOOS + "-" + runtime.GOARCH,
		Sleep:     func(time.Duration) {},
	})
	if err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(context.Background())
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, os.Interrupt)
	go func() {
		select {
		case <-signals:
		case code := <-exited:
			// `restart` asks the process to end. The test only needs to know it was asked.
			fmt.Printf("exit %d\n", code)
		}
		cancel()
	}()
	instance.Run(ctx)
	return nil
}

// dumpTools prints the CLI tool table the way the shared module computes it, so the test can compare.
func dumpTools() {
	out := map[string]any{}
	for id, t := range clitools.Tools {
		out[id] = map[string]any{
			"name": t.Name, "binary": t.Binary, "login": t.Login, "check": t.Check, "whoami": t.Whoami,
			"identityFromCheck": t.IdentityFromCheck, "logout": t.Logout, "enter": t.Enter,
			"loginEnv": clitools.LoginEnv(t, "/p"),
		}
	}
	out["_folders"] = clitools.ProfileFolders("/p")
	data, _ := json.Marshal(out)
	fmt.Println(string(data))
}
