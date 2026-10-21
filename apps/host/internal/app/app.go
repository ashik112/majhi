// Package app wires the helper: it builds every part from the settings, one platform and one set of
// machine-facing deps, and answers the server's jobs. main builds it over the real machine; the
// contract test builds it over a fake platform and fake programs.
package app

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"majhi/host/internal/checkout"
	"majhi/host/internal/client"
	"majhi/host/internal/clitools"
	"majhi/host/internal/config"
	"majhi/host/internal/editor"
	"majhi/host/internal/folders"
	"majhi/host/internal/git"
	"majhi/host/internal/jobs"
	"majhi/host/internal/laya"
	"majhi/host/internal/machine"
	"majhi/host/internal/notify"
	"majhi/host/internal/platform"
	"majhi/host/internal/protocol"
	"majhi/host/internal/run"
	"majhi/host/internal/secretskey"
	"majhi/host/internal/ssh"
	"majhi/host/internal/sys"
	"majhi/host/internal/token"
	"majhi/host/internal/update"
	"majhi/host/py"
)

const (
	factsRefresh     = 30 * time.Second
	keyBackupRefresh = 10 * time.Minute
	dockerLook       = 60 * time.Second
	dockerCall       = 15 * time.Second
	composeUp        = 300 * time.Second
	exitDelay        = 300 * time.Millisecond
	jobWait          = 15 * time.Second
)

// Options are everything the helper is built from.
type Options struct {
	Config   config.Config
	Platform platform.Platform
	Deps     sys.Deps
	// SelfPath is the file this helper runs from.
	SelfPath string
	UID, GID int
	// Exit ends the process. Tests pass a spy.
	Exit func(code int)
	// OSRelease is the kernel release, for Laya.
	OSRelease  string
	GOOS, Arch string
	// HTTP is the client used for the poll loop. Nil: the default.
	HTTP *http.Client
	// ImagePath is where the helper sits inside majhi's image, for updates.
	ImagePath string
	// SignBinary signs a new helper ad hoc on macOS after an update. Nil elsewhere.
	SignBinary func(path string)
	// Latest reads the latest-release pointer. Nil: the real one.
	Latest checkout.LatestFn
	// Sleep waits in the start-at-login flow. Nil: time.Sleep.
	Sleep func(time.Duration)
}

// App is the helper.
type App struct {
	o   Options
	log func(string)

	link     *client.Link
	handlers *jobs.Handlers

	ssh       *ssh.Ssh
	keyBackup *secretskey.Backup
	laya      *laya.Laya
	facts     *checkout.Facts

	findDocker func() *dockerState
	// compose is true when this helper has a majhi checkout to run `docker compose` in.
	compose bool

	mu        sync.Mutex
	docker    *dockerState
	wokeAt    string
	started   bool
	recovered bool
}

// dockerState is what turns on once docker is found: remount, update and the Docker facts.
type dockerState struct {
	options  update.RemountOptions
	remount  *update.Remounter
	updater  *update.Updater
	recovery update.Options
}

// New builds the helper. It makes the token and the askpass, and nothing else that touches the world.
func New(o Options) (*App, error) {
	a := &App{o: o, log: o.Deps.Log}
	cfg, deps := o.Config, o.Deps
	if _, err := token.Ensure(cfg.MajhiHome); err != nil {
		return nil, err
	}
	env := deps.Env
	path := deps.Path
	gitBin := deps.Find("git")
	if gitBin == "" {
		gitBin = "git"
	}
	var gitContext *checkout.Context
	if cfg.Repo != "" {
		gitContext = &checkout.Context{Git: gitBin, Repo: cfg.Repo, Env: withEnv(env, "PATH", path), Run: deps.Run}
	}
	bundle := filepath.Join(cfg.MajhiHome, "bin", "majhi-host")
	secretsKeyFile := env["MAJHI_SECRETS_KEY"]
	if secretsKeyFile == "" {
		secretsKeyFile = filepath.Join(cfg.Home, ".config", "majhi", "secrets.key")
	}
	plat := o.Platform
	keyringName := "the keyring"
	if plat.OS() == protocol.OSMacOS {
		keyringName = "the Keychain"
	}
	a.keyBackup = secretskey.NewBackup(secretskey.BackupDeps{
		Keyring: plat.Keyring(), Where: keyringName, ReadText: readText, KeyFile: secretsKeyFile, Log: deps.Log,
	})
	publicKeys := func() []string {
		return ssh.DiscoverPublicKeys(ssh.Files{ReadText: readText, Exists: deps.Exists, Home: cfg.Home})
	}

	// How `docker compose` runs once docker is found. MAJHI_SSH_AGENT is the agent socket the server
	// container gets (decision 1), unless the helper's own environment names one.
	var compose *update.RemountOptions
	if cfg.Repo != "" {
		sshAgent := strings.TrimSpace(env["MAJHI_SSH_AGENT"])
		if sshAgent == "" {
			sshAgent = plat.SSHAgent().ComposeSocket()
		}
		base := withEnv(env, "MAJHI_SSH_AGENT", sshAgent)
		compose = &update.RemountOptions{
			Repo: cfg.Repo,
			Env:  update.ComposeEnv(base, update.Owner{Home: cfg.Home, UID: o.UID, GID: o.GID, Path: path}),
			Run:  deps.Run, Log: deps.Log, SSHPublicKeys: publicKeys,
		}
	}

	findDocker := func() *dockerState {
		a.mu.Lock()
		if a.docker != nil || compose == nil || a.recovered {
			defer a.mu.Unlock()
			return a.docker
		}
		a.mu.Unlock()
		dockerBin := deps.Find("docker")
		if dockerBin == "" {
			return nil
		}
		found := *compose
		found.Docker = dockerBin
		state := &dockerState{options: found}
		if gitContext != nil {
			state.recovery = update.Options{
				Remount: found, Git: *gitContext, MajhiHome: cfg.MajhiHome, Bundle: bundle, SelfPath: o.SelfPath,
				ImagePath: o.ImagePath, SecretsKeyFile: secretsKeyFile, KeyBackup: a.keyBackup, Log: deps.Log,
				Exit: func() { o.Exit(0) }, Latest: o.Latest, SignBinary: o.SignBinary,
			}
			a.mu.Lock()
			a.recovered = true
			a.mu.Unlock()
			err := update.RecoverUpdate(state.recovery, nil)
			a.mu.Lock()
			a.recovered = false
			a.mu.Unlock()
			if err != nil {
				deps.Log("update recovery: " + err.Error())
				return nil
			}
			state.updater = update.New(state.recovery)
		}
		state.remount = update.NewRemounter(found)
		a.mu.Lock()
		if a.docker != nil {
			defer a.mu.Unlock()
			return a.docker
		}
		a.docker = state
		started := a.started
		a.mu.Unlock()
		if started {
			deps.Log("remounts on: found " + dockerBin)
		}
		return state
	}
	a.docker = findDocker()

	restore := secretskey.NewRestorer(secretskey.RestorerDeps{
		KeyFiles: secretskey.KeyFiles{KeyFile: secretsKeyFile, SecretsFile: filepath.Join(cfg.MajhiHome, "secrets.age")},
		Restart: func() func() error {
			// Read at each restore: majhi can be restarted once docker is found.
			if state := findDocker(); state != nil {
				return func() error { return update.RecreateServer(state.options, "secrets key") }
			}
			return nil
		},
		SaveToKeyring: func(fingerprint string) error {
			_, err := a.keyBackup.Save(fingerprint)
			return err
		},
		Log: deps.Log,
	})

	// What an update would run: the checkout's HEAD, or on a release install the latest release.
	var readTarget func() (checkout.RepoState, bool)
	if gitContext != nil {
		reader := checkout.NewTargetReader(*gitContext, nil, o.Latest)
		readTarget = reader.Read
	}
	a.facts = &checkout.Facts{
		Target: readTarget,
		Docker: func() string {
			a.mu.Lock()
			defer a.mu.Unlock()
			if a.docker == nil {
				return ""
			}
			return a.docker.options.Docker
		},
		Env: withEnv(env, "PATH", path), Run: deps.Run,
	}

	a.ssh = ssh.New(ssh.Deps{
		Run: deps.Run, ReadText: readText, Exists: deps.Exists, Home: cfg.Home, Path: path, Find: deps.Find,
		Agent: plat.SSHAgent(), Keyring: plat.Keyring(), Log: deps.Log, RuntimeDir: env["XDG_RUNTIME_DIR"],
	})
	opener := editor.New(editor.Deps{
		Run: deps.Run, Platform: plat.Editor(), Env: plat.DesktopEnv, Find: deps.Find,
		Kind: editor.PathKind, IsExecutable: editor.IsExecutableFile,
	})
	a.laya = laya.New(laya.Options{
		MajhiHome: cfg.MajhiHome, Home: cfg.Home, Path: path, GOOS: o.GOOS, Arch: o.Arch, OSRelease: o.OSRelease,
		Run: deps.Run, Source: py.Layad, Log: deps.Log,
	})
	sshBin := env["MAJHI_HOST_SSH"]
	if sshBin == "" {
		sshBin = "/usr/bin/ssh"
	}
	logins := git.LoginsDeps{
		Run: deps.Run, ReadText: git.ReadTextFile, Home: cfg.Home, Path: path,
		Socket: func() string { return plat.SSHAgent().Socket() }, Find: deps.Find, SSH: sshBin,
	}
	// majhi's own askpass for clones and pushes with a workspace's token (see git/auth.go).
	askpass, err := git.PrepareHelperDir(cfg.MajhiHome)
	if err != nil {
		return nil, err
	}
	authDeps := git.AuthDeps{MajhiHome: cfg.MajhiHome, Askpass: askpass, Path: path, Home: cfg.Home}
	pushDeps := git.PushDeps{
		Run: deps.Run, Home: cfg.Home, Path: path, Kind: editor.PathKind,
		AuthEnv: func(auth protocol.GitAuth) (git.AuthEnv, error) { return git.BuildAuthEnv(authDeps, auth) },
	}
	cloneDeps := git.CloneDeps{AuthDeps: authDeps, Run: deps.Run, Socket: logins.Socket}
	gitLogins := clitools.NewLogins(clitools.LoginDeps{
		MajhiHome: cfg.MajhiHome, Path: path, Find: deps.Find, Env: env,
	})
	toolLogins := clitools.NewToolLogins(clitools.ToolDeps{MajhiHome: cfg.MajhiHome, Path: path, Find: deps.Find, Env: env})

	a.link = &client.Link{
		URL:   cfg.URL,
		Token: func() (string, error) { return token.Ensure(cfg.MajhiHome) },
		Info:  a.info,
		Log:   deps.Log,
		HTTP:  o.HTTP,
	}
	notifier := plat.Notifier()

	h := &jobs.Handlers{
		CliLogin:       toolLogins.Login,
		CliLoginCancel: toolLogins.Cancel,
		CliCheck:       toolLogins.Check,
		CliLogout:      toolLogins.Logout,
		ListDirs:       func(p protocol.ListDirsParams) (protocol.DirListing, error) { return folders.ListDirs(p, cfg.Home) },
		MakeDir:        func(p protocol.PathParams) (map[string]string, error) { return folders.MakeDir(p, cfg.Home) },
		SuggestRoots: func() ([]protocol.RootSuggestion, error) {
			return folders.SuggestRoots(cfg.Home, plat.SkippedAtHome(), folders.DefaultBudget)
		},
		// Read at each job: remount and update turn on once docker is found.
		Remount: func() func() {
			if state := a.currentDocker(); state != nil {
				return func() { state.remount.Run() }
			}
			return nil
		},
		SSHReload:  a.ssh.Reload,
		SSHKeygen:  a.ssh.MakeKey,
		EditorOpen: opener.Open,
		MachineRead: func() (protocol.MachineHost, error) {
			return machine.Read(machine.Deps{OS: plat.OS(), Run: deps.Run, Home: cfg.Home, Env: withEnv(env, "PATH", path)})
		},
		VersionChanges: func(p protocol.VersionChangesParams) (protocol.VersionChanges, error) {
			if gitContext == nil || readTarget == nil {
				return protocol.VersionChanges{}, fmt.Errorf("This helper has no majhi checkout to read.")
			}
			repo, ok := readTarget()
			if !ok {
				return protocol.VersionChanges{}, fmt.Errorf("The majhi folder is not a git checkout.")
			}
			return protocol.VersionChanges{Head: repo.Commit, Dirty: repo.Dirty, Changes: checkout.CommitSubjects(*gitContext, p.From, repo.Commit)}, nil
		},
		Update: func() (bool, bool) {
			state := a.currentDocker()
			if state == nil || state.updater == nil {
				return false, false
			}
			return state.updater.Start(), true
		},
		Restart: func() {
			deps.Log("restarting on request")
			time.AfterFunc(exitDelay, func() { o.Exit(0) })
		},
		SSHUnlock: func(p protocol.SSHUnlockParams) (protocol.SSHStatus, error) { return a.ssh.Unlock(p.Key, p.Passphrase) },
		SecretsKeySave: func(p protocol.SecretsKeySaveParams) (protocol.SecretsKeyBackup, error) {
			return a.keyBackup.Save(p.Expected)
		},
		SecretsKeyRestore: func(p protocol.SecretsKeyRestoreParams) (protocol.SecretsKeyRestore, func(), error) {
			return restore.Restore(p.Key)
		},
		GitLogins: func(p protocol.GitLoginsParams) (protocol.GitLoginsResult, error) {
			return protocol.GitLoginsResult{Hosts: git.DetectLogins(logins, p.ExtraHosts)}, nil
		},
		GitToken:      func(p protocol.GitTokenParams) (string, error) { return git.ReadToken(logins, p.Via, p.Host) },
		GitPush:       func(p protocol.GitPushParams) error { return git.Push(pushDeps, p) },
		OpenURL:       plat.OpenURL,
		ClipboardCopy: plat.ClipboardCopy,
		GitClone: func(p protocol.GitCloneParams, progress func(protocol.CloneProgress)) (protocol.CloneResult, error) {
			return git.Clone(cloneDeps, p, progress)
		},
		GitLsRemote:       func(p protocol.GitLsRemoteParams) (protocol.LsRemoteResult, error) { return git.LsRemote(cloneDeps, p) },
		GitCliLogin:       gitLogins.Login,
		GitCliLoginCancel: gitLogins.Cancel,
		GitCredential:     func(p protocol.GitCredentialParams) (string, error) { return git.Credential(pushDeps, p) },
		Notify: func(p protocol.NotifyParams) (notify.Outcome, error) {
			return notify.Show(notifier, cfg.URL, notify.Params{Title: p.Title, Message: p.Message, Path: p.Path, Sound: p.Sound})
		},
		NotifyOpenSettings: func() bool {
			if opener, ok := notifier.(notify.SettingsOpener); ok {
				return opener.OpenSettings()
			}
			return false
		},
		LayaStatus:  a.laya.Status,
		LayaInstall: a.laya.Install,
		LayaDecide:  a.laya.Decide,
	}
	if cfg.Isolated {
		// A helper next to a test server must never reach the owner's Keychain or logins, not even
		// through the credential helper of git or `gh`.
		h.GitCredential = func(protocol.GitCredentialParams) (string, error) { return "", errIsolated }
		h.GitToken = func(protocol.GitTokenParams) (string, error) { return "", errIsolated }
		h.SecretsKeyRestore = func(protocol.SecretsKeyRestoreParams) (protocol.SecretsKeyRestore, func(), error) {
			return protocol.SecretsKeyRestore{}, nil, errIsolated
		}
	}
	a.handlers = h
	a.findDocker = findDocker
	a.compose = compose != nil
	return a, nil
}

// errIsolated answers the jobs an isolated helper (MAJHI_HOST_ISOLATED=1) never does.
var errIsolated = errors.New("Not available in isolated mode")

func (a *App) currentDocker() *dockerState {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.docker
}

func withEnv(env map[string]string, key, value string) map[string]string {
	out := make(map[string]string, len(env)+1)
	for k, v := range env {
		out[k] = v
	}
	out[key] = value
	return out
}

func readText(path string) (string, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", false
	}
	return string(data), true
}

// info is what the poll header carries.
func (a *App) info() protocol.HostInfo {
	o := a.o
	plat := o.Platform
	info := protocol.HostInfo{
		Version:  o.Config.Version,
		Platform: platform.NodePlatform(),
		OS:       plat.OS(),
		Laya:     ptr(a.laya.Status()),
	}
	if keyring := a.keyBackup.Keyring(); keyring != nil {
		info.Keyring = keyring
	}
	a.mu.Lock()
	info.CanRemount = a.docker != nil && a.docker.remount != nil
	info.WokeAt = a.wokeAt
	a.mu.Unlock()
	if status := a.ssh.Status(); status != nil {
		info.SSH = status
	}
	if repo, ok := a.facts.Repo(); ok {
		info.Commit = repo.Commit
		dirty := repo.Dirty
		info.Dirty = &dirty
	}
	info.Runtime = a.facts.Runtime()
	if secretsKey := a.keyBackup.Status(); secretsKey != nil {
		info.SecretsKey = secretsKey
	}
	return info
}

func ptr[T any](v T) *T { return &v }

// Run starts the helper's own work and answers jobs until ctx ends or the process is told to stop.
func (a *App) Run(ctx context.Context) {
	o := a.o
	deps := o.Deps
	cfg := o.Config
	plat := o.Platform
	log := deps.Log

	// On macOS this builds majhi's own notifier now, so the first notification shows as majhi.
	if preparer, ok := plat.Notifier().(notify.Preparer); ok {
		go func() {
			if err := preparer.Prepare(); err != nil {
				log("notify: " + err.Error())
			}
		}()
	}
	if a.docker == nil && a.compose {
		go func() {
			ticker := time.NewTicker(dockerLook)
			defer ticker.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
					if a.findDocker() != nil {
						return
					}
				}
			}
		}()
	}
	a.facts.Refresh()
	go func() {
		ticker := time.NewTicker(factsRefresh)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				a.facts.Refresh()
			}
		}
	}()

	remounts := "off until docker is found"
	switch {
	case a.currentDocker() != nil:
		remounts = "on, in " + cfg.Repo
	case cfg.Repo == "":
		remounts = "off, MAJHI_REPO is not set"
	}
	log(fmt.Sprintf("majhi host helper %s started on %s (pid %d, %s, remounts %s)", cfg.Version, plat.OS(), os.Getpid(), cfg.URL, remounts))
	a.mu.Lock()
	a.started = true
	a.mu.Unlock()

	// A copy of the secrets key in the keyring, made when there is none. Looked at again now and then,
	// so a deleted copy or a keyring that went away shows on Health. It never blocks the poll loop.
	go a.keyBackup.Ensure()
	go func() {
		ticker := time.NewTicker(keyBackupRefresh)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				a.keyBackup.Ensure()
			}
		}
	}()
	// Linux and WSL2: the fixed agent socket the server container uses (decision 2). macOS: nothing.
	stopForwarder := plat.SSHAgent().Serve()
	stopSSH := a.ssh.Start(func(at time.Time) {
		a.mu.Lock()
		a.wokeAt = at.UTC().Format("2006-01-02T15:04:05.000Z")
		a.mu.Unlock()
	})
	defer func() {
		stopSSH()
		stopForwarder()
		a.laya.Stop()
	}()

	if a.compose {
		// Start Docker and majhi if a login or a restart found them down. It never blocks the poll loop.
		go update.StartAtLogin(a.startupDeps())
	}

	var wg sync.WaitGroup
	a.link.PollLoop(ctx, func(job protocol.Job) {
		log(fmt.Sprintf("job %s %s", job.Method, job.ID))
		wg.Add(1)
		go func() {
			defer wg.Done()
			jobs.Run(job, a.handlers,
				func(reply protocol.Reply) error { return a.link.SendReply(context.Background(), reply) },
				func(id string, progress protocol.Progress) { a.link.SendProgress(context.Background(), id, progress) })
		}()
	})
	finished := make(chan struct{})
	go func() { wg.Wait(); close(finished) }()
	select {
	case <-finished:
	case <-time.After(jobWait):
	}
}

// startupDeps are the real commands behind the start-at-login flow. Docker is looked for at each
// step, so a CLI that appears once Docker started is used.
func (a *App) startupDeps() update.StartupDeps {
	deps := a.o.Deps
	plat := a.o.Platform
	sleep := a.o.Sleep
	if sleep == nil {
		sleep = time.Sleep
	}
	found := func() (update.RemountOptions, bool) {
		state := a.findDocker()
		if state == nil {
			return update.RemountOptions{}, false
		}
		return state.options, true
	}
	compose := func(args []string, timeout time.Duration) (run.Result, bool) {
		options, ok := found()
		if !ok {
			return run.Result{Code: run.NoCode}, false
		}
		return deps.Run(options.Docker, args, run.Options{Env: options.Env, Cwd: options.Repo, Timeout: timeout}), true
	}
	return update.StartupDeps{
		Log: deps.Log,
		DockerUp: func() bool {
			res, ok := compose([]string{"info", "--format", "{{.ID}}"}, dockerCall)
			return ok && res.Code == 0
		},
		Docker: plat.Docker(),
		MajhiRunning: func() bool {
			res, ok := compose([]string{"compose", "ps", "--status", "running", "-q", "server"}, dockerCall)
			return ok && res.Code == 0 && strings.TrimSpace(res.Stdout) != ""
		},
		StartMajhi: func() error {
			options, ok := found()
			if !ok {
				return fmt.Errorf("docker was not found")
			}
			_, err := update.DockerStep(options, "startup")("start majhi", []string{"compose", "up", "-d", "--wait"}, composeUp, nil)
			return err
		},
		Notify: func(message string) {
			_, _ = plat.Notifier().Show(notify.Request{Title: "majhi", Message: notify.PlainLine(message, 300)})
		},
		Sleep: sleep,
		Now:   time.Now,
	}
}
