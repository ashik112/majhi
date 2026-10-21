// Package protocol mirrors the zod schemas of packages/shared/src/host.ts, which stay the single
// source of truth. A contract test (e2e/host-contract) runs the helper against those schemas.
//
// Rules the structs follow, because zod `.optional()` rejects null:
//   - an optional field is omitted, never null (`omitempty`, or a pointer when zero is a real value);
//   - a list is never nil, so it is never `null`.
package protocol

import "encoding/json"

const (
	// HostInfoHeader carries HostInfo as JSON on every poll.
	HostInfoHeader = "x-majhi-host"
	// PollTimeoutMs is how long the server holds a poll.
	PollTimeoutMs = 25_000
	// TokenFile is the token's name in MAJHI_HOME.
	TokenFile = "host.token"
	// UpdateStatusFile is where an update writes its progress.
	UpdateStatusFile = "update.json"
	// OpenTasksFile is written by the server before an update.
	OpenTasksFile = "open-tasks.json"
	// HostSSHAgentSocket is the socket the helper serves on Linux and WSL2.
	HostSSHAgentSocket = "~/.majhi/run/ssh-agent.sock"
	// SSHPassphraseMax is the longest passphrase majhi accepts.
	SSHPassphraseMax = 1024
	// EditorPathMax is the longest path the editor job takes.
	EditorPathMax = 4096
)

// The operating systems the helper runs on. `wsl` is Linux inside Windows, through WSL2.
const (
	OSMacOS = "macos"
	OSLinux = "linux"
	OSWSL   = "wsl"
)

// The docker runtimes the helper tells apart.
const (
	RuntimeOrbStack      = "orbstack"
	RuntimeDockerDesktop = "docker-desktop"
	RuntimeDocker        = "docker"
)

// DirEntry is one subfolder in a listing.
type DirEntry struct {
	Name   string `json:"name"`
	Path   string `json:"path"`
	IsRepo bool   `json:"isRepo"`
	Hidden bool   `json:"hidden"`
}

// DirListing is the result of listDirs. Parent is null at the filesystem root.
type DirListing struct {
	Path      string     `json:"path"`
	Parent    *string    `json:"parent"`
	Home      string     `json:"home"`
	Entries   []DirEntry `json:"entries"`
	Truncated bool       `json:"truncated"`
}

// RootSuggestion is a first-level folder of home that holds git repos.
type RootSuggestion struct {
	Path      string `json:"path"`
	RepoCount int    `json:"repoCount"`
}

// SSHStatus is what the helper knows about SSH keys in the agent majhi's git uses.
type SSHStatus struct {
	Loaded          int      `json:"loaded"`
	NeedsPassphrase []string `json:"needsPassphrase"`
	Error           string   `json:"error,omitempty"`
	CheckedAt       string   `json:"checkedAt"`
}

// MadeSSHKey is a key the helper made.
type MadeSSHKey struct {
	Path        string `json:"path"`
	PublicKey   string `json:"publicKey"`
	Fingerprint string `json:"fingerprint,omitempty"`
}

// SecretsKeyBackup is the copy of the secrets key the helper keeps in a keyring.
type SecretsKeyBackup struct {
	Saved     string `json:"saved,omitempty"`
	Error     string `json:"error,omitempty"`
	CheckedAt string `json:"checkedAt"`
}

// SecretsKeyRestore is what a `secretsKey.restore` did.
type SecretsKeyRestore struct {
	Written   bool   `json:"written"`
	KeptAside string `json:"keptAside,omitempty"`
	Restarts  bool   `json:"restarts"`
}

// KeyringState says where the helper keeps secrets.
type KeyringState struct {
	Kind   string `json:"kind"` // keychain, secret-service or none
	Reason string `json:"reason,omitempty"`
}

// The kinds of KeyringState.
const (
	KeyringKeychain      = "keychain"
	KeyringSecretService = "secret-service"
	KeyringNone          = "none"
)

// UpdateStatus is how an update is going, written to update.json.
type UpdateStatus struct {
	State     string   `json:"state"`
	Commit    string   `json:"commit"`
	StartedAt string   `json:"startedAt"`
	Lines     []string `json:"lines"`
	Error     string   `json:"error,omitempty"`
}

// LayaStatus is Laya's install state.
type LayaStatus struct {
	State    string   `json:"state"`
	Detail   string   `json:"detail,omitempty"`
	Progress *float64 `json:"progress,omitempty"`
	Version  string   `json:"version,omitempty"`
}

// The states of LayaStatus.
const (
	LayaUnsupported  = "unsupported"
	LayaNotInstalled = "not-installed"
	LayaInstalling   = "installing"
	LayaDownloading  = "downloading"
	LayaReady        = "ready"
	LayaLoaded       = "loaded"
	LayaError        = "error"
)

// LayaQuestion is a question in Laya's own format.
type LayaQuestion struct {
	Type         string          `json:"type"`
	Instructions string          `json:"instructions"`
	Criteria     json.RawMessage `json:"criteria,omitempty"`
}

// LayaAnswer is one answer as laya-mlx returns it.
type LayaAnswer struct {
	Type          string             `json:"type"`
	Confidence    float64            `json:"confidence"`
	Choice        *string            `json:"choice,omitempty"`
	Score         *float64           `json:"score,omitempty"`
	Noul          *float64           `json:"noul,omitempty"`
	Probabilities map[string]float64 `json:"probabilities,omitempty"`
}

// LayaDecideResult is the answer to a `decide` job.
type LayaDecideResult struct {
	Answers   map[string]LayaAnswer `json:"answers"`
	LoadMs    float64               `json:"loadMs"`
	PredictMs float64               `json:"predictMs"`
}

// GitLogin is one way this computer can act as an account on a git host. It never holds a token.
type GitLogin struct {
	Via         string `json:"via"` // gh, glab or ssh
	Alias       string `json:"alias,omitempty"`
	Account     string `json:"account"`
	Fingerprint string `json:"fingerprint,omitempty"`
}

// GitAcceptedKey is an SSH key a host accepted without saying whose it is.
type GitAcceptedKey struct {
	Alias       string `json:"alias,omitempty"`
	Fingerprint string `json:"fingerprint,omitempty"`
}

// GitHostLogins is the logins found for one host.
type GitHostLogins struct {
	Host   string           `json:"host"`
	Logins []GitLogin       `json:"logins"`
	Keys   []GitAcceptedKey `json:"keys,omitempty"`
}

// GitLoginsResult is the result of git.logins.
type GitLoginsResult struct {
	Hosts []GitHostLogins `json:"hosts"`
}

// GitAuth is how the helper's git authenticates to a remote.
type GitAuth struct {
	Kind     string `json:"kind"` // token, ssh or none
	Username string `json:"username,omitempty"`
	Password string `json:"password,omitempty"`
}

// The kinds of GitAuth.
const (
	AuthToken = "token"
	AuthSSH   = "ssh"
	AuthNone  = "none"
)

// The phases of a clone, in the order git prints them.
const (
	PhaseConnecting  = "connecting"
	PhaseCounting    = "counting"
	PhaseCompressing = "compressing"
	PhaseReceiving   = "receiving"
	PhaseResolving   = "resolving"
	PhaseCheckout    = "checkout"
)

// CloneProgress is a clone phase, without the job's id.
type CloneProgress struct {
	Phase   string `json:"phase"`
	Percent *int   `json:"percent,omitempty"`
}

// LoginProgress is the page (and one-time code) a sign-in wants opened, without the job's id.
type LoginProgress struct {
	URL  string `json:"url"`
	Code string `json:"code,omitempty"`
}

// Progress is one line of progress for a running job. Exactly one of Clone and Login is set.
type Progress struct {
	Clone *CloneProgress
	Login *LoginProgress
}

// MarshalWith writes the progress with the job's id, as HostProgressSchema reads it.
func (p Progress) MarshalWith(id string) ([]byte, error) {
	if p.Login != nil {
		return json.Marshal(struct {
			ID    string        `json:"id"`
			Login LoginProgress `json:"login"`
		}{id, *p.Login})
	}
	clone := CloneProgress{Phase: PhaseConnecting}
	if p.Clone != nil {
		clone = *p.Clone
	}
	return json.Marshal(struct {
		ID string `json:"id"`
		CloneProgress
	}{id, clone})
}

// GitCliLoginResult is what a `git.cliLogin` ended with.
type GitCliLoginResult struct {
	State        string `json:"state"` // missing, done or cancelled
	Token        string `json:"token,omitempty"`
	RefreshToken string `json:"refreshToken,omitempty"`
	ExpiresAt    string `json:"expiresAt,omitempty"`
}

// CliLoginResult is what a `cli.login` ended with.
type CliLoginResult struct {
	State    string `json:"state"` // missing, done, other-account or cancelled
	Identity string `json:"identity,omitempty"`
}

// CliCheckResult is what a `cli.check` found.
type CliCheckResult struct {
	OK       bool   `json:"ok"`
	Identity string `json:"identity,omitempty"`
	Detail   string `json:"detail"`
	Failure  string `json:"failure,omitempty"` // tool-missing, not-signed-in or timeout
}

// The reasons a CLI check is not ok.
const (
	FailureToolMissing = "tool-missing"
	FailureNotSignedIn = "not-signed-in"
	FailureTimeout     = "timeout"
)

// VersionChanges is the result of version.changes.
type VersionChanges struct {
	Head    string   `json:"head"`
	Dirty   bool     `json:"dirty"`
	Changes []string `json:"changes"`
}

// NotifyResult is the result of notify.
type NotifyResult struct {
	Shown     bool `json:"shown"`
	Clickable bool `json:"clickable"`
	Blocked   bool `json:"blocked,omitempty"`
}

// CloneResult is the result of git.clone.
type CloneResult struct {
	Head   string `json:"head"`
	Branch string `json:"branch"`
}

// LsRemoteResult is the result of git.lsRemote.
type LsRemoteResult struct {
	Empty         bool   `json:"empty"`
	DefaultBranch string `json:"defaultBranch,omitempty"`
}

// MachineHost is this computer right now. Optional numbers are pointers because zero is a real reading.
type MachineHost struct {
	Cores             int      `json:"cores"`
	Load1             float64  `json:"load1"`
	Load5             float64  `json:"load5"`
	Load15            float64  `json:"load15"`
	MemTotalBytes     float64  `json:"memTotalBytes"`
	MemAvailableBytes *float64 `json:"memAvailableBytes,omitempty"`
	Pressure          string   `json:"pressure,omitempty"`
	IdleCPUPct        *float64 `json:"idleCpuPct,omitempty"`
	DiskFreeBytes     *float64 `json:"diskFreeBytes,omitempty"`
	DiskTotalBytes    *float64 `json:"diskTotalBytes,omitempty"`
}

// HostInfo is sent in the x-majhi-host header on every poll.
type HostInfo struct {
	Version    string            `json:"version"`
	Platform   string            `json:"platform"`
	OS         string            `json:"os,omitempty"`
	Keyring    *KeyringState     `json:"keyring,omitempty"`
	CanRemount bool              `json:"canRemount"`
	SSH        *SSHStatus        `json:"ssh,omitempty"`
	Commit     string            `json:"commit,omitempty"`
	Dirty      *bool             `json:"dirty,omitempty"`
	Runtime    string            `json:"dockerRuntime,omitempty"`
	Laya       *LayaStatus       `json:"laya,omitempty"`
	SecretsKey *SecretsKeyBackup `json:"secretsKey,omitempty"`
	WokeAt     string            `json:"wokeAt,omitempty"`
}

// Reply is the answer to a job: a result, or an error in plain words.
type Reply struct {
	ID     string
	Result any
	Error  string
	Failed bool
}

// OKReply answers with a result.
func OKReply(id string, result any) Reply { return Reply{ID: id, Result: result} }

// ErrReply answers with an error message.
func ErrReply(id, message string) Reply { return Reply{ID: id, Error: message, Failed: true} }

// MarshalJSON writes {id, ok, result} or {id, ok:false, error}.
func (r Reply) MarshalJSON() ([]byte, error) {
	if r.Failed {
		return json.Marshal(struct {
			ID    string `json:"id"`
			OK    bool   `json:"ok"`
			Error string `json:"error"`
		}{r.ID, false, r.Error})
	}
	return json.Marshal(struct {
		ID     string `json:"id"`
		OK     bool   `json:"ok"`
		Result any    `json:"result"`
	}{r.ID, true, r.Result})
}
