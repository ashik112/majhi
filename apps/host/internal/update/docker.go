// Package update rebuilds majhi from its checkout, restarts it and replaces the helper, with a
// journal so an update that stops half-way goes back to the previous version at the next start.
package update

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"majhi/host/internal/hostlog"
	"majhi/host/internal/run"
)

// OverrideFile is the compose override generated from majhi.yaml.
const OverrideFile = "docker-compose.override.yml"

const (
	genTimeout = 120 * time.Second
	upTimeout  = 300 * time.Second
	// stderrTail is how much of a failed command's stderr goes into the log.
	stderrTail = 2_000
	maxOutput  = 1 << 20
)

// RemountOptions say how to run `docker compose` in the majhi checkout.
type RemountOptions struct {
	// Repo is the majhi checkout holding docker-compose.yml.
	Repo string
	// Docker is the absolute path of `docker`.
	Docker string
	// Env is the environment for `docker compose`: the owner's HOME, HOST_UID, HOST_GID and a PATH with Docker on it.
	Env map[string]string
	Run run.Func
	Log hostlog.Logger
	// SSHPublicKeys are the absolute `.pub` files to mount read-only. Only the host can tell which exist.
	SSHPublicKeys func() []string
}

// Owner is the user the compose environment is for.
type Owner struct {
	Home     string
	UID, GID int
	Path     string
}

// ComposeEnv is the environment `make up` gives `docker compose`, so a remount starts majhi the same way.
func ComposeEnv(base map[string]string, owner Owner) map[string]string {
	env := make(map[string]string, len(base)+5)
	for k, v := range base {
		env[k] = v
	}
	env["HOME"] = owner.Home
	env["HOST_UID"] = fmt.Sprint(owner.UID)
	env["HOST_GID"] = fmt.Sprint(owner.GID)
	env["PATH"] = owner.Path
	// Days of tokens and cost follow this computer's zone, as with `make up`.
	if env["MAJHI_TZ"] == "" {
		env["MAJHI_TZ"] = localZoneName(base["TZ"])
	}
	return env
}

// localZoneName is this computer's IANA zone: TZ, else where /etc/localtime points, else UTC.
func localZoneName(tz string) string {
	if tz = strings.TrimPrefix(tz, ":"); tz != "" {
		return tz
	}
	if target, err := os.Readlink("/etc/localtime"); err == nil {
		if _, name, ok := strings.Cut(target, "zoneinfo/"); ok && name != "" {
			return name
		}
	}
	return "UTC"
}

// Step runs one `docker` step and fails in plain words, with the tail of stderr, when it fails.
// stepEnv replaces the environment when it is not nil.
type Step func(label string, args []string, timeout time.Duration, stepEnv map[string]string) (string, error)

// DockerStep builds the Step for options. prefix names the flow in the log.
func DockerStep(o RemountOptions, prefix string) Step {
	return func(label string, args []string, timeout time.Duration, stepEnv map[string]string) (string, error) {
		o.Log(fmt.Sprintf("%s: %s: docker %s", prefix, label, strings.Join(args, " ")))
		env := o.Env
		if stepEnv != nil {
			env = stepEnv
		}
		res := o.Run(o.Docker, args, run.Options{Env: env, Cwd: o.Repo, Timeout: timeout, MaxOutput: maxOutput, Tail: true})
		if res.Code == 0 {
			return res.Stdout, nil
		}
		reason := "Command failed: docker " + strings.Join(args, " ")
		switch {
		case res.TimedOut:
			reason = fmt.Sprintf("timed out after %ds", int(timeout.Round(time.Second)/time.Second))
		case res.Code == run.NoCode && res.Stderr == "":
			reason = "could not run docker"
		}
		tail := strings.TrimSpace(res.Stderr)
		if len(tail) > stderrTail {
			tail = tail[len(tail)-stderrTail:]
		}
		message := label + " failed: " + reason
		if tail != "" {
			message += "\n" + tail
		}
		return "", errors.New(message)
	}
}

// Remounter regenerates the override and recreates the server, one run at a time.
type Remounter struct {
	options RemountOptions
	mu      sync.Mutex
}

// NewRemounter builds the remounter.
func NewRemounter(options RemountOptions) *Remounter { return &Remounter{options: options} }

// Run regenerates `docker-compose.override.yml` from majhi.yaml and recreates the server container.
// It never fails: the server was already told the remount started, so failures go to the log.
func (r *Remounter) Run() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	started := time.Now()
	target := filepath.Join(r.options.Repo, OverrideFile)
	if err := RegenerateAndUp(r.options, "remount", nil); err != nil {
		_ = os.Remove(fmt.Sprintf("%s.%d.tmp", target, os.Getpid()))
		r.options.Log("remount: " + err.Error())
		return false
	}
	r.options.Log(fmt.Sprintf("remount: done in %.1fs", time.Since(started).Seconds()))
	return true
}

// RegenerateAndUp regenerates `docker-compose.override.yml` from majhi.yaml with the image on disk,
// then starts (or recreates) majhi and waits until it is healthy. It fails with the failed step's
// reason. onStep hears the plain-words name of each step as it starts.
func RegenerateAndUp(o RemountOptions, prefix string, onStep func(string)) error {
	if onStep == nil {
		onStep = func(string) {}
	}
	target := filepath.Join(o.Repo, OverrideFile)
	temp := fmt.Sprintf("%s.%d.tmp", target, os.Getpid())
	step := DockerStep(o, prefix)
	var keys []string
	if o.SSHPublicKeys != nil {
		keys = o.SSHPublicKeys()
	}
	onStep("Generating the folder mounts")
	env := make(map[string]string, len(o.Env)+1)
	for k, v := range o.Env {
		env[k] = v
	}
	env["MAJHI_SSH_PUBKEYS"] = strings.Join(keys, "\n")
	override, err := step("generate mounts", []string{
		"compose", "run", "--rm", "--no-deps", "-T",
		"-e", "MAJHI_SSH_PUBKEYS", "-e", "MAJHI_SSH_AGENT", "-e", "MAJHI_LAYA_GPU",
		"server", "node", "dist/cli.js", "gen-override",
	}, genTimeout, env)
	if err != nil {
		return err
	}
	if strings.TrimSpace(override) == "" {
		return errors.New("generate mounts printed nothing, so the override was kept")
	}
	if err := os.WriteFile(temp, []byte(override), 0o644); err != nil {
		return fmt.Errorf("write %s: %w", temp, err)
	}
	if err := os.Rename(temp, target); err != nil {
		return fmt.Errorf("replace %s: %w", target, err)
	}
	o.Log(fmt.Sprintf("%s: wrote %s", prefix, target))
	onStep("Starting the new majhi and waiting until it is healthy")
	_, err = step("restart majhi", []string{"compose", "up", "-d", "--wait"}, upTimeout, nil)
	return err
}

// RecreateServer recreates majhi's server container and waits until it is healthy. A running
// container keeps the files it mounted, so a replaced secrets key file only reaches majhi this way.
func RecreateServer(o RemountOptions, prefix string) error {
	_, err := DockerStep(o, prefix)("restart majhi", []string{"compose", "up", "-d", "--force-recreate", "--wait", "server"}, upTimeout, nil)
	return err
}
