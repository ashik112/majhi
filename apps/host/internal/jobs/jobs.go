// Package jobs answers each job the server sends. Handlers do the work; this package only decides
// what the reply looks like, so every reply parses against the shared schemas.
package jobs

import (
	"fmt"

	"majhi/host/internal/notify"
	"majhi/host/internal/protocol"
)

// Messages for a job this helper cannot do here.
const (
	// NotBuilt is the answer for a job this helper has no handler for. It names no operating system.
	NotBuilt = "This host helper cannot do that yet. Update majhi and try again."
	// CannotUpdate is the answer to `update` without a checkout or docker.
	CannotUpdate = "The host helper cannot run docker compose here, so it cannot update majhi. Run `make up` in the majhi folder."
	// CannotRemount is the answer to `remount` without docker.
	CannotRemount = "The host helper cannot run docker compose here. Run `make up` in the majhi folder to mount the new roots."
)

// Handlers do the work of each method. A field left nil gets NotBuilt, or its own answer where noted.
// Every error message is shown to the owner, so it is a plain sentence.
type Handlers struct {
	ListDirs       func(protocol.ListDirsParams) (protocol.DirListing, error)
	SuggestRoots   func() ([]protocol.RootSuggestion, error)
	MakeDir        func(protocol.PathParams) (map[string]string, error)
	SSHReload      func() (protocol.SSHStatus, error)
	SSHKeygen      func() (protocol.MadeSSHKey, error)
	SSHUnlock      func(protocol.SSHUnlockParams) (protocol.SSHStatus, error)
	VersionChanges func(protocol.VersionChangesParams) (protocol.VersionChanges, error)
	MachineRead    func() (protocol.MachineHost, error)
	// Remount is read at each job: it turns on once docker is found. It returns nil when this helper
	// cannot run docker compose. The returned function runs after the reply is sent.
	Remount func() func()
	// Update starts the update and returns false when one is already running. It returns supported
	// false without a checkout or docker.
	Update func() (started bool, supported bool)
	// Restart ends the helper so its login service starts it again. It runs after the reply.
	Restart        func()
	SecretsKeySave func(protocol.SecretsKeySaveParams) (protocol.SecretsKeyBackup, error)
	// SecretsKeyRestore writes a restored key. `after` runs once the reply is sent and never fails.
	SecretsKeyRestore  func(protocol.SecretsKeyRestoreParams) (result protocol.SecretsKeyRestore, after func(), err error)
	GitLogins          func(protocol.GitLoginsParams) (protocol.GitLoginsResult, error)
	GitToken           func(protocol.GitTokenParams) (string, error)
	GitPush            func(protocol.GitPushParams) error
	GitCredential      func(protocol.GitCredentialParams) (string, error)
	GitClone           func(p protocol.GitCloneParams, progress func(protocol.CloneProgress)) (protocol.CloneResult, error)
	GitLsRemote        func(protocol.GitLsRemoteParams) (protocol.LsRemoteResult, error)
	GitCliLogin        func(p protocol.GitCliLoginParams, progress func(protocol.LoginProgress)) (protocol.GitCliLoginResult, error)
	GitCliLoginCancel  func(signIn string) bool
	CliLogin           func(p protocol.CliLoginParams, progress func(protocol.LoginProgress)) (protocol.CliLoginResult, error)
	CliLoginCancel     func(signIn string) bool
	CliCheck           func(protocol.CliToolParams) (protocol.CliCheckResult, error)
	CliLogout          func(protocol.CliToolParams) (map[string]bool, error)
	LayaStatus         func() protocol.LayaStatus
	LayaInstall        func() protocol.LayaStatus
	LayaDecide         func(protocol.DecideParams) (protocol.LayaDecideResult, error)
	EditorOpen         func(protocol.EditorOpenParams) error
	Notify             func(protocol.NotifyParams) (notify.Outcome, error)
	NotifyOpenSettings func() bool
	OpenURL            func(url string) bool
	ClipboardCopy      func(text string) bool
}

// Send posts the reply to a job.
type Send func(protocol.Reply) error

// SendProgress posts progress of a running job. Failures are dropped.
type SendProgress func(id string, progress protocol.Progress)

// Run answers one job. Nothing here panics out: a failing job is answered with its message.
// `remount`, `restart` and `secretsKey.restore` are answered before they restart the server the
// reply goes to.
func Run(job protocol.Job, h *Handlers, reply Send, progress SendProgress) {
	defer func() {
		if r := recover(); r != nil {
			_ = reply(protocol.ErrReply(job.ID, fmt.Sprintf("The helper hit an error it could not handle: %v", r)))
		}
	}()
	ok := func(result any) { _ = reply(protocol.OKReply(job.ID, result)) }
	fail := func(message string) { _ = reply(protocol.ErrReply(job.ID, message)) }
	failErr := func(err error) { fail(err.Error()) }
	notBuilt := func() { fail(NotBuilt) }
	cloneProgress := func(p protocol.CloneProgress) { progress(job.ID, protocol.Progress{Clone: &p}) }
	loginProgress := func(p protocol.LoginProgress) { progress(job.ID, protocol.Progress{Login: &p}) }

	switch job.Method {
	case protocol.MethodMkdir:
		if h.MakeDir == nil {
			notBuilt()
			return
		}
		if r, err := h.MakeDir(job.Params.(protocol.PathParams)); err != nil {
			failErr(err)
		} else {
			ok(r)
		}
	case protocol.MethodListDirs:
		if h.ListDirs == nil {
			notBuilt()
			return
		}
		if r, err := h.ListDirs(job.Params.(protocol.ListDirsParams)); err != nil {
			failErr(err)
		} else {
			ok(r)
		}
	case protocol.MethodSuggestRoots:
		if h.SuggestRoots == nil {
			notBuilt()
			return
		}
		r, err := h.SuggestRoots()
		if err != nil {
			failErr(err)
			return
		}
		if r == nil {
			r = []protocol.RootSuggestion{}
		}
		ok(map[string]any{"suggestions": r})
	case protocol.MethodSSHReload:
		if h.SSHReload == nil {
			notBuilt()
			return
		}
		if r, err := h.SSHReload(); err != nil {
			failErr(err)
		} else {
			ok(r)
		}
	case protocol.MethodVersionChanges:
		if h.VersionChanges == nil {
			notBuilt()
			return
		}
		r, err := h.VersionChanges(job.Params.(protocol.VersionChangesParams))
		if err != nil {
			failErr(err)
			return
		}
		if r.Changes == nil {
			r.Changes = []string{}
		}
		ok(r)
	case protocol.MethodMachineRead:
		if h.MachineRead == nil {
			notBuilt()
			return
		}
		if r, err := h.MachineRead(); err != nil {
			failErr(err)
		} else {
			ok(r)
		}
	case protocol.MethodUpdate:
		if h.Update == nil {
			fail(CannotUpdate)
			return
		}
		started, supported := h.Update()
		switch {
		case !supported:
			fail(CannotUpdate)
		case !started:
			fail("An update is already running.")
		default:
			ok(map[string]bool{"accepted": true})
		}
	case protocol.MethodRestart:
		ok(map[string]bool{"accepted": true})
		if h.Restart != nil {
			h.Restart()
		}
	case protocol.MethodDecisionsStatus:
		if h.LayaStatus == nil {
			notBuilt()
			return
		}
		ok(h.LayaStatus())
	case protocol.MethodDecisionsInstall:
		if h.LayaInstall == nil {
			notBuilt()
			return
		}
		ok(h.LayaInstall())
	case protocol.MethodDecide:
		if h.LayaDecide == nil {
			notBuilt()
			return
		}
		if r, err := h.LayaDecide(job.Params.(protocol.DecideParams)); err != nil {
			failErr(err)
		} else {
			ok(r)
		}
	case protocol.MethodEditorOpen:
		if h.EditorOpen == nil {
			notBuilt()
			return
		}
		if err := h.EditorOpen(job.Params.(protocol.EditorOpenParams)); err != nil {
			failErr(err)
		} else {
			ok(map[string]bool{"opened": true})
		}
	case protocol.MethodNotify:
		runNotify(job, h, ok, fail)
	case protocol.MethodNotifyOpenSettings:
		opened := h.NotifyOpenSettings != nil && h.NotifyOpenSettings()
		ok(map[string]bool{"opened": opened})
	case protocol.MethodGitLogins:
		if h.GitLogins == nil {
			notBuilt()
			return
		}
		r, err := h.GitLogins(job.Params.(protocol.GitLoginsParams))
		if err != nil {
			failErr(err)
			return
		}
		if r.Hosts == nil {
			r.Hosts = []protocol.GitHostLogins{}
		}
		ok(r)
	case protocol.MethodGitToken:
		if h.GitToken == nil {
			notBuilt()
			return
		}
		if token, err := h.GitToken(job.Params.(protocol.GitTokenParams)); err != nil {
			failErr(err)
		} else {
			ok(map[string]string{"token": token})
		}
	case protocol.MethodGitPush:
		if h.GitPush == nil {
			notBuilt()
			return
		}
		if err := h.GitPush(job.Params.(protocol.GitPushParams)); err != nil {
			failErr(err)
		} else {
			ok(map[string]bool{"pushed": true})
		}
	case protocol.MethodOpenURL:
		opened := h.OpenURL != nil && h.OpenURL(job.Params.(protocol.OpenURLParams).URL)
		ok(map[string]bool{"opened": opened})
	case protocol.MethodClipboardCopy:
		copied := h.ClipboardCopy != nil && h.ClipboardCopy(job.Params.(protocol.ClipboardParams).Text)
		ok(map[string]bool{"copied": copied})
	case protocol.MethodGitClone:
		if h.GitClone == nil {
			notBuilt()
			return
		}
		if r, err := h.GitClone(job.Params.(protocol.GitCloneParams), cloneProgress); err != nil {
			failErr(err)
		} else {
			ok(r)
		}
	case protocol.MethodGitLsRemote:
		if h.GitLsRemote == nil {
			notBuilt()
			return
		}
		if r, err := h.GitLsRemote(job.Params.(protocol.GitLsRemoteParams)); err != nil {
			failErr(err)
		} else {
			ok(r)
		}
	case protocol.MethodGitCliLogin:
		if h.GitCliLogin == nil {
			notBuilt()
			return
		}
		if r, err := h.GitCliLogin(job.Params.(protocol.GitCliLoginParams), loginProgress); err != nil {
			failErr(err)
		} else {
			ok(r)
		}
	case protocol.MethodGitCliLoginCancel:
		cancelled := h.GitCliLoginCancel != nil && h.GitCliLoginCancel(job.Params.(protocol.SignInParams).SignIn)
		ok(map[string]bool{"cancelled": cancelled})
	case protocol.MethodCliLogin:
		if h.CliLogin == nil {
			notBuilt()
			return
		}
		if r, err := h.CliLogin(job.Params.(protocol.CliLoginParams), loginProgress); err != nil {
			failErr(err)
		} else {
			ok(r)
		}
	case protocol.MethodCliLoginCancel:
		cancelled := h.CliLoginCancel != nil && h.CliLoginCancel(job.Params.(protocol.SignInParams).SignIn)
		ok(map[string]bool{"cancelled": cancelled})
	case protocol.MethodCliCheck:
		if h.CliCheck == nil {
			notBuilt()
			return
		}
		if r, err := h.CliCheck(job.Params.(protocol.CliToolParams)); err != nil {
			failErr(err)
		} else {
			ok(r)
		}
	case protocol.MethodCliLogout:
		if h.CliLogout == nil {
			notBuilt()
			return
		}
		if r, err := h.CliLogout(job.Params.(protocol.CliToolParams)); err != nil {
			failErr(err)
		} else {
			ok(r)
		}
	case protocol.MethodGitCredential:
		if h.GitCredential == nil {
			notBuilt()
			return
		}
		if secret, err := h.GitCredential(job.Params.(protocol.GitCredentialParams)); err != nil {
			failErr(err)
		} else {
			ok(map[string]string{"secret": secret})
		}
	case protocol.MethodSSHKeygen:
		if h.SSHKeygen == nil {
			notBuilt()
			return
		}
		if r, err := h.SSHKeygen(); err != nil {
			failErr(err)
		} else {
			ok(r)
		}
	case protocol.MethodSSHUnlock:
		if h.SSHUnlock == nil {
			notBuilt()
			return
		}
		if r, err := h.SSHUnlock(job.Params.(protocol.SSHUnlockParams)); err != nil {
			failErr(err)
		} else {
			ok(r)
		}
	case protocol.MethodSecretsKeySave:
		if h.SecretsKeySave == nil {
			notBuilt()
			return
		}
		if r, err := h.SecretsKeySave(job.Params.(protocol.SecretsKeySaveParams)); err != nil {
			failErr(err)
		} else {
			ok(r)
		}
	case protocol.MethodSecretsKeyRestore:
		if h.SecretsKeyRestore == nil {
			notBuilt()
			return
		}
		result, after, err := h.SecretsKeyRestore(job.Params.(protocol.SecretsKeyRestoreParams))
		if err != nil {
			failErr(err)
			return
		}
		ok(result)
		if after != nil {
			after()
		}
	case protocol.MethodRemount:
		var remount func()
		if h.Remount != nil {
			remount = h.Remount()
		}
		if remount == nil {
			fail(CannotRemount)
			return
		}
		ok(map[string]bool{"accepted": true})
		remount()
	default:
		fail(NotBuilt)
	}
}

func runNotify(job protocol.Job, h *Handlers, ok func(any), fail func(string)) {
	if h.Notify == nil {
		fail(NotBuilt)
		return
	}
	outcome, err := h.Notify(job.Params.(protocol.NotifyParams))
	if err != nil {
		fail(err.Error())
		return
	}
	switch outcome.Kind {
	case notify.Shown:
		ok(protocol.NotifyResult{Shown: true, Clickable: outcome.Clickable})
	case notify.Blocked:
		ok(protocol.NotifyResult{Shown: false, Clickable: false, Blocked: true})
	case notify.Unavailable:
		fail("majhi's notifier is not ready yet. Try again in a minute.")
	default:
		fail(outcome.Error)
	}
}
