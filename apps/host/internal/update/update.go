package update

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"majhi/host/internal/checkout"
	"majhi/host/internal/durable"
	"majhi/host/internal/hostlog"
	"majhi/host/internal/protocol"
)

const (
	buildTimeout = 20 * time.Minute
	keyTimeout   = 60 * time.Second
	maxLines     = 40
	// recoveryImage is the new image kept for the database recovery tool.
	recoveryImage  = "majhi-server:update-recovery"
	previousServer = "majhi-server:previous"
	previousRunner = "majhi-runner:previous"
	previousLaya   = "majhi-laya:previous"
	databaseDir    = "update-databases"
	layaContainer  = "majhi-laya"
	cudaTorchIndex = "https://download.pytorch.org/whl/cu130"
	serverLogLines = 40
)

// BuildRetry is how long to wait before the 2nd and 3rd try of a build that failed because the network did not answer.
var BuildRetry = []time.Duration{15 * time.Second, 45 * time.Second}

// KeyBackup is the keyring copy of the secrets key: put back when the file is gone, made after a new key.
type KeyBackup interface {
	Read() (string, bool)
	Ensure() *protocol.SecretsKeyBackup
	Where() string
}

// Options say how an update runs.
type Options struct {
	Remount RemountOptions
	Git     checkout.Context
	// MajhiHome is `<MAJHI_HOME>`, where `update.json` is written.
	MajhiHome string
	// Bundle is where the installed helper lives, `<MAJHI_HOME>/bin/majhi-host`.
	Bundle string
	// SelfPath is the file this helper runs from. The helper only exits to be replaced when it is the bundle.
	SelfPath string
	// ImagePath is where the new helper sits inside the new image.
	ImagePath      string
	SecretsKeyFile string
	KeyBackup      KeyBackup
	Log            hostlog.Logger
	Now            func() time.Time
	// Exit ends the process so the login service (launchd or systemd) starts the new helper. Tests pass a spy.
	Exit func()
	// Sleep waits before exiting, so the last status write and log line reach disk.
	Sleep func(time.Duration)
	// Latest reads the latest-release pointer on a release install. Tests pass a fake.
	Latest checkout.LatestFn
	// SignBinary signs the new helper ad hoc on macOS. Nil elsewhere.
	SignBinary func(path string)
}

// Updater rebuilds majhi from the checkout and restarts it, as `make up` does: build with the same
// environment and the commit baked in, keep the secrets key, regenerate the mounts, `up -d --wait`,
// then install the helper from the new image and let the login service restart it. On a release
// install it first updates runtime files or the legacy checkout, and the same build then takes that
// release's images instead of compiling: compose decides. It reports to `update.json` because the
// server that would relay progress is replaced part-way. It never fails.
type Updater struct {
	o       Options
	mu      sync.Mutex
	running bool
}

// New builds the updater.
func New(o Options) *Updater {
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Sleep == nil {
		o.Sleep = time.Sleep
	}
	return &Updater{o: o}
}

// Start starts an update in the background. It returns false when one is already running.
func (u *Updater) Start() bool {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.running {
		return false
	}
	u.running = true
	go func() {
		defer func() {
			if r := recover(); r != nil {
				u.o.Log(fmt.Sprintf("update: %v", r))
			}
			u.mu.Lock()
			u.running = false
			u.mu.Unlock()
		}()
		u.runUpdate()
	}()
	return true
}

// Wait blocks until no update runs. For tests.
func (u *Updater) Wait() {
	for {
		u.mu.Lock()
		running := u.running
		u.mu.Unlock()
		if !running {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
}

type kept = KeptImage

func (u *Updater) runUpdate() {
	o := u.o
	file := filepath.Join(o.MajhiHome, protocol.UpdateStatusFile)
	status := protocol.UpdateStatus{State: "running", StartedAt: o.Now().UTC().Format("2006-01-02T15:04:05.000Z"), Lines: []string{}}
	write := func() {
		temp := fmt.Sprintf("%s.%d.tmp", file, os.Getpid())
		if os.MkdirAll(filepath.Dir(file), 0o755) != nil {
			return
		}
		data, err := json.Marshal(status)
		if err != nil || os.WriteFile(temp, data, 0o644) != nil {
			return
		}
		_ = os.Rename(temp, file)
	}
	say := func(text string) {
		o.Log("update: " + text)
		status.Lines = append(status.Lines, text)
		if len(status.Lines) > maxLines {
			status.Lines = status.Lines[len(status.Lines)-maxLines:]
		}
		write()
	}

	var pendingMove *checkout.Moved
	restorePackage := func() {
		if pendingMove == nil {
			return
		}
		moved := *pendingMove
		pendingMove = nil
		if err := checkout.MoveBack(o.Git, moved); err != nil {
			say(fmt.Sprintf("Could not restore majhi %s: %s", moved.From, firstLine(err.Error())))
		} else {
			say("Back on majhi " + moved.From)
		}
	}

	err := u.attempt(&status, say, &pendingMove)
	if err == nil {
		return
	}
	var recoveryErr error
	func() {
		transaction, readErr := ReadJournal(o.MajhiHome)
		if readErr != nil {
			recoveryErr = readErr
			say("Recovery is still pending: " + readErr.Error())
			return
		}
		if transaction == nil {
			restorePackage()
			return
		}
		if backErr := RecoverUpdate(o, say); backErr != nil {
			recoveryErr = backErr
			say("Recovery is still pending: " + backErr.Error())
			return
		}
		pendingMove = nil
		if transaction.Phase == PhaseCommitted {
			say("The new version is running")
		} else {
			say("Went back to the previous version")
		}
	}()
	status.State = "failed"
	status.Error = err.Error()
	if recoveryErr != nil {
		status.Error += "\nRecovery is still pending: " + recoveryErr.Error()
	}
	say("Failed: " + firstLine(err.Error()))
}

func firstLine(text string) string {
	line, _, _ := strings.Cut(text, "\n")
	return line
}

// attempt is the update itself. It fails with the reason; the caller goes back from the journal.
func (u *Updater) attempt(status *protocol.UpdateStatus, say func(string), pendingMove **checkout.Moved) error {
	o := u.o
	remount := o.Remount
	if err := RecoverUpdate(o, nil); err != nil {
		return err
	}
	say("Reading the installed version")
	before, ok := checkout.ReadRepo(o.Git)
	if !ok {
		return errors.New("The majhi folder has neither a runtime package nor a source checkout.")
	}
	moved, err := checkout.MoveToLatest(o.Git, before.Commit, say, o.Latest)
	if err != nil {
		return err
	}
	*pendingMove = moved
	repo := before
	if moved != nil {
		if again, ok := checkout.ReadRepo(o.Git); ok {
			repo = again
		}
	}
	status.Commit = repo.Commit
	if repo.Dirty {
		say("The folder has changes you have not committed. They are part of this build.")
	}

	// The same environment `make up` gives compose, plus the commit the image should carry.
	base := withEnv(remount.Env, "MAJHI_COMMIT", repo.Commit)
	layaOn := layaInDocker(DockerStep(withDockerEnv(remount, base), "update"), base)
	env := base
	if layaOn {
		env = layaEnv(remount.Repo, base)
	}
	stepOptions := withDockerEnv(remount, env)
	step := DockerStep(stepOptions, "update")
	plain := simple(step)

	images := []imageKeep{{ServerImage, previousServer}, {RunnerImage, previousRunner}}
	if layaOn {
		images = append(images, imageKeep{LayaImage, previousLaya})
	}
	previous := []kept{}
	for _, p := range images {
		id, err := keepPrevious(step, p.image, p.keep)
		if err != nil {
			return err
		}
		if id != "" {
			previous = append(previous, kept{Image: p.image, ID: id})
		}
	}
	journal := Journal{Version: 1, Phase: PhasePrepared, Previous: previous, Moved: moved}
	if mounts, err := os.ReadFile(filepath.Join(remount.Repo, OverrideFile)); err == nil {
		text := string(mounts)
		journal.Mounts = &text
	}
	if err := WriteJournal(o.MajhiHome, journal); err != nil {
		return err
	}
	switch pkg, _ := checkout.ReadPackage(o.Git.Repo); {
	case moved != nil:
		say("Getting the majhi " + moved.To + " images")
	case pkg != nil:
		say("Getting the installed release images")
	default:
		say("Building the new image. This takes a few minutes")
	}
	// The runner image too: agents run in it (it is never started by compose). Laya's as `make up` does.
	build := []string{"compose", "--profile", "runner"}
	if layaOn {
		build = append(build, "--profile", "laya")
	}
	build = append(build, "build")
	if err := buildWithRetries(func() error {
		_, err := step("build", build, buildTimeout, nil)
		return err
	}, say, o.Sleep); err != nil {
		return err
	}

	if err := u.start(&journal, env, step, say, previous); err != nil {
		return err
	}

	// The new server passed its health check. From here the installed release is committed.
	journal.Phase = PhaseCommitted
	if err := WriteJournal(o.MajhiHome, journal); err != nil {
		return err
	}
	*pendingMove = nil
	if err := finishTransaction(o, step); err != nil {
		return err
	}
	cleanAfterUpdate(plain, say, o.MajhiHome, keepTags(images))
	if moved != nil {
		RemoveOtherReleases(plain, moved.To, say)
	}
	say("Installing the new host helper")
	replaced := installBundle(o, stepOptions)
	status.State = "done"
	if replaced {
		say("Done. Restarting the host helper")
	} else {
		say("Done")
	}
	if replaced && sameFile(o.SelfPath, o.Bundle) {
		o.Sleep(500 * time.Millisecond)
		o.Exit()
	}
	return nil
}

// imageKeep is an image and the tag that keeps its previous version.
type imageKeep struct{ image, keep string }

func keepTags(images []imageKeep) []string {
	tags := make([]string, len(images))
	for i, p := range images {
		tags[i] = p.keep
	}
	return tags
}

// start takes the database snapshot and starts the new majhi. A failure says why the new one did not start.
func (u *Updater) start(journal *Journal, env map[string]string, step Step, say func(string), previous []kept) error {
	o := u.o
	err := func() error {
		if err := ensureSecretsKey(o, env, say); err != nil {
			return err
		}
		if _, err := step("keep the database recovery tool", []string{"tag", ServerImage, recoveryImage}, keyTimeout, nil); err != nil {
			return err
		}
		journal.Phase = PhaseSnapshotting
		if err := WriteJournal(o.MajhiHome, *journal); err != nil {
			return err
		}
		if _, err := step("stop majhi before its database snapshot", []string{"compose", "stop", "server"}, keyTimeout, nil); err != nil {
			return err
		}
		if err := databaseStep(o, step, "update-snapshot"); err != nil {
			return err
		}
		journal.Phase = PhaseStarting
		if err := WriteJournal(o.MajhiHome, *journal); err != nil {
			return err
		}
		return RegenerateAndUp(withDockerEnv(o.Remount, env), "update", say)
	}()
	if err == nil {
		return nil
	}
	reason := crashReason(step)
	if reason != "" {
		say("The new majhi said: " + reason)
	}
	hasServer := false
	for _, k := range previous {
		if k.Image == ServerImage {
			hasServer = true
		}
	}
	if hasServer {
		say("The new majhi did not start. Going back to the previous version")
	} else {
		say("No previous version to go back to")
	}
	if reason != "" {
		return errors.New(err.Error() + "\n" + reason)
	}
	return err
}

func withEnv(env map[string]string, key, value string) map[string]string {
	out := make(map[string]string, len(env)+1)
	for k, v := range env {
		out[k] = v
	}
	out[key] = value
	return out
}

func withDockerEnv(o RemountOptions, env map[string]string) RemountOptions {
	o.Env = env
	return o
}

func sameFile(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	ra, errA := filepath.EvalSymlinks(a)
	rb, errB := filepath.EvalSymlinks(b)
	if errA != nil || errB != nil {
		return a == b
	}
	return ra == rb
}

// databaseStep: the new image's CLI takes snapshots without starting the server or migrating either database.
func databaseStep(o Options, step Step, command string) error {
	home := o.MajhiHome
	args := []string{"run", "--rm", "--network", "none"}
	if uid, gid := o.Remount.Env["HOST_UID"], o.Remount.Env["HOST_GID"]; uid != "" && gid != "" {
		args = append(args, "--user", uid+":"+gid)
	}
	args = append(args,
		"--mount", "type=bind,source="+home+",target="+home,
		"--env", "MAJHI_HOME="+home,
		recoveryImage, "node", "dist/cli.js", command)
	_, err := step(command, args, buildTimeout, nil)
	return err
}

func finishTransaction(o Options, step Step) error {
	if err := checkout.CommitPackage(o.Git.Repo); err != nil {
		return err
	}
	if err := os.RemoveAll(filepath.Join(o.MajhiHome, databaseDir)); err != nil {
		return err
	}
	if err := ClearJournal(o.MajhiHome); err != nil {
		return err
	}
	_, _ = step("remove the database recovery tool", []string{"image", "rm", recoveryImage}, keyTimeout, nil)
	return nil
}

func reportRecoveredUpdate(o Options, committed bool) error {
	file := filepath.Join(o.MajhiHome, protocol.UpdateStatusFile)
	data, err := os.ReadFile(file)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var status protocol.UpdateStatus
	if err := json.Unmarshal(data, &status); err != nil {
		return err
	}
	if status.State != "running" {
		return nil
	}
	if committed {
		status.State = "done"
	} else {
		status.State = "failed"
		status.Error = "An interrupted update was recovered. Majhi is back on the previous version."
	}
	line := "Recovered the previous version after an interrupted update"
	if committed {
		line = "Update completed; recovery files removed"
	}
	status.Lines = append(status.Lines, line)
	if len(status.Lines) > maxLines {
		status.Lines = status.Lines[len(status.Lines)-maxLines:]
	}
	return durable.WriteJSON(file, status)
}

// RecoverUpdate runs before accepting host jobs. Recovery remains on disk until every rollback step succeeds.
func RecoverUpdate(o Options, say func(string)) error {
	journal, err := ReadJournal(o.MajhiHome)
	if err != nil {
		return err
	}
	if journal == nil {
		_, err := checkout.RecoverPackage(o.Git.Repo)
		return err
	}
	step := DockerStep(o.Remount, "update recovery")
	if journal.Phase == PhaseCommitted {
		if err := finishTransaction(o, step); err != nil {
			return err
		}
		if say == nil {
			return reportRecoveredUpdate(o, true)
		}
		return nil
	}
	o.Log("update recovery: restoring the interrupted update")
	// Stop first, including after a helper crash while the new server was already running.
	if journal.Phase != PhasePrepared {
		if _, err := step("stop majhi for recovery", []string{"compose", "stop", "server"}, keyTimeout, nil); err != nil {
			return err
		}
		if journal.Phase == PhaseStarting {
			if err := databaseStep(o, step, "update-restore"); err != nil {
				return err
			}
		}
	}
	if journal.Moved != nil {
		if err := checkout.MoveBack(o.Git, *journal.Moved); err != nil {
			return err
		}
		if say != nil {
			say("Back on majhi " + journal.Moved.From)
		}
	} else if _, err := checkout.RecoverPackage(o.Git.Repo); err != nil {
		return err
	}
	if err := goBack(step, o.Remount.Repo, journal.Previous, journal.Mounts, journal.Phase != PhasePrepared); err != nil {
		return err
	}
	journal.Phase = PhaseCommitted
	if err := WriteJournal(o.MajhiHome, *journal); err != nil {
		return err
	}
	if err := finishTransaction(o, step); err != nil {
		return err
	}
	if say == nil {
		return reportRecoveredUpdate(o, false)
	}
	return nil
}

// ensureSecretsKey: `make up` creates the key when it is missing. The helper does the same, so a
// fresh computer needs no terminal. A key the keyring still holds comes back first: a new key could
// not read `secrets.age`.
func ensureSecretsKey(o Options, env map[string]string, say func(string)) error {
	if info, err := os.Stat(o.SecretsKeyFile); err == nil && info.Size() > 0 {
		return nil
	}
	if o.KeyBackup != nil {
		if saved, ok := o.KeyBackup.Read(); ok {
			say("Putting back the secrets key from " + o.KeyBackup.Where())
			return writeKey(o.SecretsKeyFile, saved+"\n")
		}
	}
	say("Creating the secrets key")
	step := DockerStep(withDockerEnv(o.Remount, env), "update")
	// Not `compose run`: compose refuses to start while the secret file it names is missing.
	key, err := step("create secrets key", []string{"run", "--rm", "--pull", "never", ServerImage, "node", "dist/cli.js", "gen-key"}, keyTimeout, nil)
	if err != nil {
		return err
	}
	if strings.TrimSpace(key) == "" {
		return errors.New("create secrets key printed nothing")
	}
	if err := writeKey(o.SecretsKeyFile, key); err != nil {
		return err
	}
	if o.KeyBackup != nil {
		o.KeyBackup.Ensure()
	}
	return nil
}

func writeKey(file, key string) error {
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		return err
	}
	temp := file + ".tmp"
	if err := os.WriteFile(temp, []byte(key), 0o600); err != nil {
		return err
	}
	return os.Rename(temp, file)
}

// installBundle copies the helper out of the new image over the installed binary. The running
// process keeps its loaded copy.
func installBundle(o Options, remount RemountOptions) bool {
	step := DockerStep(remount, "update")
	id := ""
	defer func() {
		if id != "" {
			_, _ = step("remove the copy", []string{"rm", id}, keyTimeout, nil)
		}
	}()
	fail := func(err error) bool {
		o.Log("update: could not replace the helper: " + err.Error())
		_ = os.Remove(o.Bundle + ".tmp")
		return false
	}
	out, err := step("create a copy of the image", []string{"create", ServerImage}, keyTimeout, nil)
	if err != nil {
		return fail(err)
	}
	id = strings.TrimSpace(out)
	if err := os.MkdirAll(filepath.Dir(o.Bundle), 0o755); err != nil {
		return fail(err)
	}
	temp := o.Bundle + ".tmp"
	if _, err := step("copy the helper out", []string{"cp", id + ":" + o.ImagePath, temp}, keyTimeout, nil); err != nil {
		return fail(err)
	}
	if err := os.Chmod(temp, 0o755); err != nil {
		return fail(err)
	}
	if o.SignBinary != nil {
		o.SignBinary(temp)
	}
	if err := os.Rename(temp, o.Bundle); err != nil {
		return fail(err)
	}
	return true
}

// layaInDocker says whether `make up` runs Laya in Docker. It records its mode in MAJHI_LAYA. A
// helper installed before that has no record: Laya is in Docker when `make up` gave it the GPU or
// its container exists.
func layaInDocker(step Step, env map[string]string) bool {
	if mode := strings.TrimSpace(env["MAJHI_LAYA"]); mode != "" {
		return mode == "docker"
	}
	if env["MAJHI_LAYA_GPU"] == "nvidia" {
		return true
	}
	out, err := step("find Laya's container", []string{"container", "inspect", "--format", "{{.Id}}", layaContainer}, keyTimeout, nil)
	return err == nil && strings.TrimSpace(out) != ""
}

// layaEnv is the environment that builds and starts Laya as `make up` does: its profile, so `up`
// recreates it, and on an NVIDIA GPU the CUDA build args. `make up` records those; without the
// record they are worked out as the Makefile does, and a torch index in `.env` reaches compose on its own.
func layaEnv(repo string, env map[string]string) map[string]string {
	var profiles []string
	for _, p := range strings.Split(env["COMPOSE_PROFILES"], ",") {
		if p != "" && p != "laya" {
			profiles = append(profiles, p)
		}
	}
	out := withEnv(env, "COMPOSE_PROFILES", strings.Join(append(profiles, "laya"), ","))
	if env["MAJHI_LAYA_GPU"] != "nvidia" {
		return out
	}
	if out["MAJHI_LAYA_DEVICE"] == "" {
		out["MAJHI_LAYA_DEVICE"] = "cuda"
	}
	if out["MAJHI_LAYA_TORCH_INDEX"] == "" {
		dotenv, _ := os.ReadFile(filepath.Join(repo, ".env"))
		if !hasDotenvKey(string(dotenv), "MAJHI_LAYA_TORCH_INDEX") {
			out["MAJHI_LAYA_TORCH_INDEX"] = cudaTorchIndex
		}
	}
	return out
}

func hasDotenvKey(dotenv, key string) bool {
	for _, line := range strings.Split(dotenv, "\n") {
		if name, _, ok := strings.Cut(line, "="); ok && strings.TrimSpace(name) == key {
			return true
		}
	}
	return false
}

// keepPrevious tags the image majhi runs now, so the build cannot orphan it. "" when there is none yet.
func keepPrevious(step Step, image, keep string) (string, error) {
	out, err := step("find the running image", []string{"image", "inspect", "--format", "{{.Id}}", image}, keyTimeout, nil)
	id := strings.TrimSpace(out)
	if err != nil || id == "" {
		return "", nil
	}
	if _, err := step("keep the running image", []string{"tag", id, keep}, keyTimeout, nil); err != nil {
		return "", err
	}
	return id, nil
}

// cleanAfterUpdate: after a successful update and health check, removes majhi's own old images (see
// hygiene.go). It never prunes the build cache or anything unlabelled. Best effort: a failed clean-up
// never fails an update that already runs.
func cleanAfterUpdate(step simpleStep, say func(string), majhiHome string, tags []string) {
	say("Removing the old majhi images")
	RemoveOwnLeftovers(step, majhiHome, say, tags)
}

// goBack puts the previous images and mounts back and starts majhi on them.
func goBack(step Step, repo string, previous []kept, mounts *string, restart bool) error {
	for _, k := range previous {
		if _, err := step("go back to the previous image", []string{"tag", k.ID, k.Image}, keyTimeout, nil); err != nil {
			return err
		}
	}
	if mounts != nil {
		target := filepath.Join(repo, OverrideFile)
		temp := fmt.Sprintf("%s.%d.tmp", target, os.Getpid())
		if err := os.WriteFile(temp, []byte(*mounts), 0o644); err != nil {
			return err
		}
		if err := os.Rename(temp, target); err != nil {
			return err
		}
	}
	if !restart {
		return nil
	}
	hasServer := false
	for _, k := range previous {
		if k.Image == ServerImage {
			hasServer = true
		}
	}
	if !hasServer {
		return errors.New("No previous server image is available for recovery")
	}
	_, err := step("start the previous majhi", []string{"compose", "up", "-d", "--wait"}, buildTimeout, nil)
	return err
}

// crashReason is the last error-looking line of the server's log, the reason `--wait` only calls "unhealthy".
func crashReason(step Step) string {
	log, err := step("read the server log", []string{"compose", "logs", "--no-color", "--no-log-prefix", "--tail", fmt.Sprint(serverLogLines), "server"}, keyTimeout, nil)
	if err != nil {
		return ""
	}
	var lines []string
	for _, l := range strings.Split(log, "\n") {
		if l = strings.TrimSpace(stripComposePrefix(l)); l != "" {
			lines = append(lines, l)
		}
	}
	for i := len(lines) - 1; i >= 0; i-- {
		lower := strings.ToLower(lines[i])
		if containsAny(lower, "error", "exception", "failed", "cannot", "refused") {
			return lines[i]
		}
	}
	return ""
}

// stripComposePrefix drops compose's `server-1  | ` log prefix.
func stripComposePrefix(line string) string {
	i := 0
	for i < len(line) && (line[i] == '-' || line[i] == '.' || line[i] == '_' || (line[i] >= '0' && line[i] <= '9') ||
		(line[i] >= 'a' && line[i] <= 'z') || (line[i] >= 'A' && line[i] <= 'Z')) {
		i++
	}
	if i == 0 {
		return line
	}
	j := i
	for j < len(line) && (line[j] == ' ' || line[j] == '\t') {
		j++
	}
	if j == i || j >= len(line) || line[j] != '|' {
		return line
	}
	j++
	if j < len(line) && line[j] == ' ' {
		j++
	}
	return line[j:]
}

func containsAny(lower string, phrases ...string) bool {
	for _, p := range phrases {
		if strings.Contains(lower, p) {
			return true
		}
	}
	return false
}

// LooksLikeNetwork is a build error from the network, not from the code: DNS, TLS, timeouts, resets.
func LooksLikeNetwork(message string) bool {
	return containsAny(strings.ToLower(message), "no such host", "tls handshake timeout", "i/o timeout",
		"connection reset", "connection refused", "network is unreachable", "failed to fetch oauth token",
		"failed to do request", "temporary failure in name resolution", "eai_again", "etimedout")
}

// buildWithRetries runs the build, trying again on network errors; the last error says so in plain words.
func buildWithRetries(build func() error, say func(string), sleep func(time.Duration)) error {
	for attempt := 0; ; attempt++ {
		err := build()
		if err == nil {
			return nil
		}
		if !LooksLikeNetwork(err.Error()) {
			return err
		}
		if attempt >= len(BuildRetry) {
			return fmt.Errorf("build failed: the image registry could not be reached after %d tries. Check your internet connection, then update again.\n%s", attempt+1, err.Error())
		}
		wait := BuildRetry[attempt]
		say(fmt.Sprintf("The image registry did not answer. Trying again in %d seconds (%d of %d)", int(wait.Seconds()), attempt+2, len(BuildRetry)+1))
		sleep(wait)
	}
}
