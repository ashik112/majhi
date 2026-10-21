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
	"strconv"
	"strings"
	"syscall"
	"time"

	"majhi/host/internal/app"
	"majhi/host/internal/config"
	"majhi/host/internal/hostlog"
	"majhi/host/internal/platform"
	"majhi/host/internal/run"
	"majhi/host/internal/service"
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
	if len(os.Args) > 1 && os.Args[1] == "install-service" {
		return installService(cfg, osName, env, os.Args[2:])
	}
	if len(os.Args) > 1 && os.Args[1] == "--ssh-dry-run" {
		sshDryRun(cfg, osName, env)
		return nil
	}
	log, err := hostlog.NewFile(filepath.Join(cfg.MajhiHome, "logs", "host.log"), hostlog.MaxBytes)
	if err != nil {
		return err
	}
	deps := sys.Real(env, osName, cfg.Home, cfg.MajhiHome, log, cfg.Notify)
	plat := platform.New(osName, deps, cfg.Notify, cfg.Isolated)
	self, err := os.Executable()
	if err != nil {
		self = ""
	}
	instance, err := app.New(app.Options{
		Config: cfg, Platform: plat, Deps: deps, SelfPath: self,
		UID: os.Getuid(), GID: os.Getgid(),
		Exit: func(code int) {
			// Whatever a job started (a clone, a sign-in, a build) goes with the helper.
			run.KillAll()
			os.Exit(code)
		},
		OSRelease: kernelRelease(deps), GOOS: runtime.GOOS, Arch: runtime.GOARCH,
		ImagePath:  imagePath(),
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
		run.KillAll()
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

// sshDryRun reports what the key loader would do on this computer, and changes nothing: no `ssh-add`
// add, no Keychain load, no keyring change. It prints paths and short fingerprints.
func sshDryRun(cfg config.Config, osName string, env map[string]string) {
	quiet := func(string) {}
	deps := sys.Real(env, osName, cfg.Home, cfg.MajhiHome, quiet, false)
	plat := platform.New(osName, deps, false, false)
	keys := ssh.New(ssh.Deps{
		Run: deps.Run, ReadText: readText, Exists: deps.Exists, Home: cfg.Home, Path: deps.Path, Find: deps.Find,
		Agent: plat.SSHAgent(), Keyring: plat.Keyring(), Log: quiet, DryRun: true,
	})
	report := keys.Inspect()
	socket := report.Socket
	if socket == "" {
		socket = "none"
	}
	fmt.Printf("agent socket: %s\nkeys in the agent: %d\n", socket, report.Status.Loaded)
	for _, key := range report.Keys {
		line := fmt.Sprintf("  %-16s %s", key.State, key.Path)
		if key.Fingerprint != "" {
			line += "  " + key.Fingerprint
		}
		fmt.Println(line)
	}
	if len(report.Keys) == 0 {
		fmt.Println("  no key files found")
	}
	if report.Status.Error != "" {
		fmt.Println("error: " + report.Status.Error)
	}
}

// imagePath is where the helper for this OS and CPU sits inside majhi's image.
func imagePath() string {
	path := "/app/host/majhi-host-" + runtime.GOOS + "-" + runtime.GOARCH
	if runtime.GOOS == "windows" {
		path += ".exe"
	}
	return path
}

// installService writes the login service (the LaunchAgent, or the systemd user units) for this binary
// and loads it. `scripts/host.sh install` runs it after it copies the binary out of the image. With
// `--from-legacy` it is the second half of a switch from the Node helper: the transition shim started
// it, and it first waits for the shim (`--wait-pid`) to exit, then takes over the service and removes
// the old `.mjs`.
func installService(cfg config.Config, osName string, env map[string]string, args []string) error {
	fromLegacy := false
	waitPID := 0
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--from-legacy":
			fromLegacy = true
		case "--wait-pid":
			if i+1 < len(args) {
				waitPID, _ = strconv.Atoi(args[i+1])
				i++
			}
		default:
			return fmt.Errorf("install-service does not take %q", args[i])
		}
	}
	self, err := os.Executable()
	if err != nil {
		return err
	}
	if resolved, err := filepath.EvalSymlinks(self); err == nil {
		self = resolved
	}
	log, err := hostlog.NewFile(filepath.Join(cfg.MajhiHome, "logs", "host.log"), hostlog.MaxBytes)
	if err != nil {
		return err
	}
	if fromLegacy {
		// Only one switch at a time: the old service starts the shim again as soon as it exits.
		lock, err := service.TakeLock(filepath.Join(cfg.MajhiHome, "run", "install-service.lock"), 5*time.Minute)
		if err != nil {
			return nil
		}
		defer lock()
		if waitPID > 0 {
			service.WaitForExit(waitPID, 30*time.Second)
		}
		log("service: switching from the Node helper to " + self)
	}
	opts := service.Options{
		Env: env, OS: osName, Home: cfg.Home, MajhiHome: cfg.MajhiHome, Repo: cfg.Repo, Bin: self,
		UID: os.Getuid(), Run: run.Exec, Say: func(line string) { fmt.Println("host helper: " + line) }, Log: log,
	}
	if err := service.Install(opts); err != nil {
		log("service: could not install the login service: " + err.Error())
		return err
	}
	if fromLegacy {
		_ = os.Remove(filepath.Join(cfg.MajhiHome, "bin", "majhi-host.mjs"))
		log("service: the helper now runs as the binary at " + self)
	}
	return nil
}
