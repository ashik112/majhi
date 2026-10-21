// majhi host helper: runs on the owner's computer, outside Docker, and does the few jobs the
// container cannot: list host folders, suggest workspace roots, remount roots by recreating the
// server container, git with the owner's logins, the ssh agent, the keyring, CLI sign-ins,
// notifications, the editor, the clipboard, updates, disk cleanup and Laya. It opens no port; it
// polls the server (SPEC 4.2). Everything that differs per OS goes through the platform built for
// the OS found at start (internal/platform).
package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"

	"majhi/host/internal/app"
	"majhi/host/internal/config"
	"majhi/host/internal/hostlog"
	"majhi/host/internal/platform"
	"majhi/host/internal/run"
	"majhi/host/internal/ssh"
	"majhi/host/internal/sys"
)

// version is set by the build (-ldflags "-X main.version=...").
var version = "0.0.0"

func main() {
	config.DefaultVersion = version
	if err := start(); err != nil {
		// Goes to stderr, which the login service (the LaunchAgent on macOS, the systemd user unit on
		// Linux and WSL2) appends to ~/.majhi/logs/host.out, and the service restarts the helper.
		fmt.Fprintf(os.Stderr, "majhi host helper failed: %v\n", err)
		os.Exit(1)
	}
}

func environment() map[string]string {
	env := map[string]string{}
	for _, entry := range os.Environ() {
		if name, value, ok := strings.Cut(entry, "="); ok {
			env[name] = value
		}
	}
	return env
}

func start() error {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return fmt.Errorf("cannot find the home folder: %v", err)
	}
	env := environment()
	cfg, err := config.Parse(env, home)
	if err != nil {
		return err
	}
	osName := platform.CurrentOS(env)
	if osName == "" {
		fmt.Fprintln(os.Stderr, "majhi's host helper runs on macOS, Linux and WSL2.")
		os.Exit(1)
	}
	for _, arg := range os.Args[1:] {
		switch arg {
		case "--version":
			fmt.Println(cfg.Version)
			return nil
		case "--ssh-pubkeys":
			// For `make up`: the .pub files to mount, one per line. Nothing else is printed.
			files := ssh.Files{ReadText: readText, Exists: exists, Home: cfg.Home}
			for _, key := range ssh.DiscoverPublicKeys(files) {
				fmt.Println(key)
			}
			return nil
		}
	}
	log, err := hostlog.NewFile(filepath.Join(cfg.MajhiHome, "logs", "host.log"), hostlog.MaxBytes)
	if err != nil {
		return err
	}
	deps := sys.Real(env, osName, cfg.Home, cfg.MajhiHome, log, cfg.Notify)
	plat := platform.New(osName, deps, cfg.Notify)
	self, err := os.Executable()
	if err != nil {
		self = ""
	}
	instance, err := app.New(app.Options{
		Config: cfg, Platform: plat, Deps: deps, SelfPath: self,
		UID: os.Getuid(), GID: os.Getgid(),
		Exit:      func(code int) { os.Exit(code) },
		OSRelease: kernelRelease(deps), GOOS: runtime.GOOS, Arch: runtime.GOARCH,
		ImagePath:  "/app/host/majhi-host-" + runtime.GOOS + "-" + runtime.GOARCH,
		SignBinary: signer(deps),
	})
	if err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, os.Interrupt)
	go func() {
		sig := <-signals
		log(fmt.Sprintf("stopping (%s)", signalName(sig)))
		cancel()
	}()
	instance.Run(ctx)
	return nil
}

func signalName(sig os.Signal) string {
	if sig == os.Interrupt {
		return "SIGINT"
	}
	return "SIGTERM"
}

func readText(path string) (string, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", false
	}
	return string(data), true
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// kernelRelease is `uname -r`: Darwin's number tells Laya which macOS this is.
func kernelRelease(deps sys.Deps) string {
	out, err := exec.Command("uname", "-r").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// signer signs a new helper ad hoc on macOS, as the notifier is, when `codesign` is there.
// Developer ID signing needs the owner's certificate and is a later step.
func signer(deps sys.Deps) func(path string) {
	if runtime.GOOS != "darwin" {
		return nil
	}
	return func(path string) {
		const codesign = "/usr/bin/codesign"
		if !deps.Exists(codesign) {
			return
		}
		res := deps.Run(codesign, []string{"--force", "--sign", "-", path}, run.Options{Env: map[string]string{"PATH": "/usr/bin:/bin"}, Timeout: 30_000_000_000})
		if res.Code != 0 {
			deps.Log("update: could not sign the new helper ad hoc")
		}
	}
}
