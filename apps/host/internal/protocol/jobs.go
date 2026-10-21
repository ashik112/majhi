package protocol

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
)

// The job methods, as the server names them.
const (
	MethodListDirs           = "listDirs"
	MethodMkdir              = "fs.mkdir"
	MethodSuggestRoots       = "suggestRoots"
	MethodMachineRead        = "machine.read"
	MethodRemount            = "remount"
	MethodSSHReload          = "ssh.reload"
	MethodSSHKeygen          = "ssh.keygen"
	MethodVersionChanges     = "version.changes"
	MethodUpdate             = "update"
	MethodRestart            = "restart"
	MethodDecisionsStatus    = "decisions.status"
	MethodDecisionsInstall   = "decisions.install"
	MethodDecide             = "decide"
	MethodEditorOpen         = "editor.open"
	MethodNotify             = "notify"
	MethodNotifyOpenSettings = "notify.openSettings"
	MethodGitLogins          = "git.logins"
	MethodGitToken           = "git.token"
	MethodGitPush            = "git.push"
	MethodOpenURL            = "openUrl"
	MethodClipboardCopy      = "clipboard.copy"
	MethodGitCliLogin        = "git.cliLogin"
	MethodCliLogin           = "cli.login"
	MethodCliLoginCancel     = "cli.loginCancel"
	MethodCliCheck           = "cli.check"
	MethodCliLogout          = "cli.logout"
	MethodGitCliLoginCancel  = "git.cliLoginCancel"
	MethodGitClone           = "git.clone"
	MethodGitLsRemote        = "git.lsRemote"
	MethodGitCredential      = "git.credential"
	MethodSSHUnlock          = "ssh.unlock"
	MethodSecretsKeySave     = "secretsKey.save"
	MethodSecretsKeyRestore  = "secretsKey.restore"
)

// Job is one job from the server. Params holds the typed params of its method (nil for `{}`).
type Job struct {
	ID     string
	Method string
	Params any
}

// Params of each method.
type (
	ListDirsParams struct {
		Path       string `json:"path"`
		ShowHidden bool   `json:"showHidden"`
	}
	PathParams struct {
		Path string `json:"path"`
	}
	VersionChangesParams struct {
		From string `json:"from"`
	}
	DecideParams struct {
		State     string                  `json:"state"`
		Questions map[string]LayaQuestion `json:"questions"`
	}
	EditorOpenParams struct {
		App  string `json:"app"`
		Path string `json:"path"`
		Line *int   `json:"line,omitempty"`
	}
	NotifyParams struct {
		Title   string `json:"title"`
		Message string `json:"message"`
		Path    string `json:"path,omitempty"`
		Sound   bool   `json:"sound"`
	}
	GitLoginsParams struct {
		ExtraHosts []string `json:"extraHosts"`
	}
	GitTokenParams struct {
		Via  string `json:"via"`
		Host string `json:"host"`
	}
	GitPushParams struct {
		Path        string   `json:"path"`
		URL         string   `json:"url"`
		Branch      string   `json:"branch"`
		Auth        *GitAuth `json:"auth,omitempty"`
		SetUpstream bool     `json:"setUpstream,omitempty"`
	}
	OpenURLParams struct {
		URL string `json:"url"`
	}
	ClipboardParams struct {
		Text string `json:"text"`
	}
	GitCliLoginParams struct {
		SignIn string `json:"signIn"`
		CLI    string `json:"cli"`
		Org    string `json:"org"`
		Host   string `json:"host"`
	}
	CliLoginParams struct {
		SignIn     string `json:"signIn"`
		Tool       string `json:"tool"`
		Connection string `json:"connection"`
		Expected   string `json:"expected,omitempty"`
	}
	SignInParams struct {
		SignIn string `json:"signIn"`
	}
	CliToolParams struct {
		Tool       string `json:"tool"`
		Connection string `json:"connection"`
	}
	GitCloneParams struct {
		Clone  string  `json:"clone"`
		URL    string  `json:"url"`
		Path   string  `json:"path"`
		Branch string  `json:"branch,omitempty"`
		Auth   GitAuth `json:"auth"`
	}
	GitLsRemoteParams struct {
		URL  string  `json:"url"`
		Auth GitAuth `json:"auth"`
	}
	GitCredentialParams struct {
		Host     string `json:"host"`
		Username string `json:"username"`
	}
	SSHUnlockParams struct {
		Key        string `json:"key"`
		Passphrase string `json:"passphrase"`
	}
	SecretsKeySaveParams struct {
		Expected string `json:"expected"`
	}
	SecretsKeyRestoreParams struct {
		Key string `json:"key"`
	}
)

// ParseError says why a job did not parse, with what the helper needs to answer it.
type ParseError struct {
	ID     string
	Method string
	Reason string
}

func (e *ParseError) Error() string { return e.Reason }

// ParseJob reads one job body the way HostJobSchema does. A job that does not parse is answered
// with the reason, when it has an id to answer to.
func ParseJob(body []byte) (Job, *ParseError) {
	var head struct {
		ID     any             `json:"id"`
		Method any             `json:"method"`
		Params json.RawMessage `json:"params"`
	}
	if err := json.Unmarshal(body, &head); err != nil {
		return Job{}, &ParseError{Method: "unknown", Reason: "not a job"}
	}
	id, _ := head.ID.(string)
	method := "unknown"
	if head.Method != nil {
		method = fmt.Sprint(head.Method)
	}
	fail := func(reason string) (Job, *ParseError) {
		return Job{}, &ParseError{ID: id, Method: method, Reason: reason}
	}
	name, ok := head.Method.(string)
	if !ok || head.ID == nil {
		return fail("missing id or method")
	}
	if _, isString := head.ID.(string); !isString {
		return fail("id is not a string")
	}
	params, err := parseParams(name, head.Params)
	if err != nil {
		return fail(err.Error())
	}
	return Job{ID: id, Method: name, Params: params}, nil
}

func decode[T any](raw json.RawMessage, check func(*T) error) (any, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, errors.New("params are missing")
	}
	var v T
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil, err
	}
	if check != nil {
		if err := check(&v); err != nil {
			return nil, err
		}
	}
	return v, nil
}

func between(name string, value string, min, max int) error {
	n := len([]rune(value))
	if n < min || n > max {
		return fmt.Errorf("%s has a bad length", name)
	}
	return nil
}

func parseParams(method string, raw json.RawMessage) (any, error) {
	switch method {
	case MethodListDirs:
		return decode[ListDirsParams](raw, nil)
	case MethodMkdir:
		return decode[PathParams](raw, nil)
	case MethodSuggestRoots, MethodMachineRead, MethodRemount, MethodSSHReload, MethodSSHKeygen, MethodUpdate,
		MethodRestart, MethodDecisionsStatus, MethodDecisionsInstall, MethodNotifyOpenSettings:
		return nil, nil
	case MethodVersionChanges:
		return decode(raw, func(p *VersionChangesParams) error {
			if !IsCommit(p.From) {
				return errors.New("from is not a commit")
			}
			return nil
		})
	case MethodDecide:
		return decode(raw, func(p *DecideParams) error {
			for _, q := range p.Questions {
				if q.Type != "choice" && q.Type != "score" && q.Type != "noul" {
					return errors.New("question type")
				}
			}
			return nil
		})
	case MethodEditorOpen:
		return decode(raw, func(p *EditorOpenParams) error {
			if p.App != "vscode" && p.App != "cursor" {
				return errors.New("app")
			}
			if p.Line != nil && *p.Line < 1 {
				return errors.New("line")
			}
			return between("path", p.Path, 1, EditorPathMax)
		})
	case MethodNotify:
		return decode(raw, func(p *NotifyParams) error {
			if err := between("title", p.Title, 1, 120); err != nil {
				return err
			}
			if err := between("message", p.Message, 1, 300); err != nil {
				return err
			}
			if p.Path != "" && (len(p.Path) > 300 || !strings.HasPrefix(p.Path, "/") || strings.HasPrefix(p.Path, "//")) {
				return errors.New("path")
			}
			return nil
		})
	case MethodGitLogins:
		return decode(raw, func(p *GitLoginsParams) error {
			if len(p.ExtraHosts) > 50 {
				return errors.New("too many hosts")
			}
			for _, h := range p.ExtraHosts {
				if len(h) > 255 {
					return errors.New("host too long")
				}
			}
			if p.ExtraHosts == nil {
				p.ExtraHosts = []string{}
			}
			return nil
		})
	case MethodGitToken:
		return decode(raw, func(p *GitTokenParams) error {
			if p.Via != "gh" && p.Via != "glab" {
				return errors.New("via")
			}
			return between("host", p.Host, 1, 255)
		})
	case MethodGitPush:
		return decode(raw, func(p *GitPushParams) error {
			if err := between("path", p.Path, 1, 4096); err != nil {
				return err
			}
			if err := between("url", p.URL, 1, 2048); err != nil {
				return err
			}
			if err := between("branch", p.Branch, 1, 255); err != nil {
				return err
			}
			if p.Auth != nil {
				return checkAuth(p.Auth)
			}
			return nil
		})
	case MethodOpenURL:
		return decode(raw, func(p *OpenURLParams) error {
			if len(p.URL) > 4096 || !IsWebURL(p.URL) {
				return errors.New("url")
			}
			return nil
		})
	case MethodClipboardCopy:
		return decode(raw, func(p *ClipboardParams) error { return between("text", p.Text, 1, 8192) })
	case MethodGitCliLogin:
		return decode(raw, func(p *GitCliLoginParams) error {
			if !IsSignInID(p.SignIn) || (p.CLI != "gh" && p.CLI != "glab") || !IsID(p.Org) {
				return errors.New("bad sign-in")
			}
			host, ok := NormalizeGitHost(p.Host)
			if !ok {
				return errors.New("host")
			}
			p.Host = host
			return nil
		})
	case MethodCliLogin:
		return decode(raw, func(p *CliLoginParams) error {
			if !IsSignInID(p.SignIn) || !IsCliTool(p.Tool) || !IsID(p.Connection) || len(p.Expected) > 200 {
				return errors.New("bad sign-in")
			}
			return nil
		})
	case MethodCliLoginCancel, MethodGitCliLoginCancel:
		return decode(raw, func(p *SignInParams) error {
			if !IsSignInID(p.SignIn) {
				return errors.New("signIn")
			}
			return nil
		})
	case MethodCliCheck, MethodCliLogout:
		return decode(raw, func(p *CliToolParams) error {
			if !IsCliTool(p.Tool) || !IsID(p.Connection) {
				return errors.New("tool")
			}
			return nil
		})
	case MethodGitClone:
		return decode(raw, func(p *GitCloneParams) error {
			if !IsCloneID(p.Clone) {
				return errors.New("clone")
			}
			clean, ok := CleanRemoteURL(p.URL)
			if !ok {
				return errors.New("url")
			}
			p.URL = clean
			if err := between("path", p.Path, 1, 4096); err != nil {
				return err
			}
			if p.Branch != "" && len(p.Branch) > 255 {
				return errors.New("branch")
			}
			return checkAuth(&p.Auth)
		})
	case MethodGitLsRemote:
		return decode(raw, func(p *GitLsRemoteParams) error {
			clean, ok := CleanRemoteURL(p.URL)
			if !ok {
				return errors.New("url")
			}
			p.URL = clean
			return checkAuth(&p.Auth)
		})
	case MethodGitCredential:
		return decode(raw, func(p *GitCredentialParams) error {
			if err := between("host", p.Host, 1, 255); err != nil {
				return err
			}
			return between("username", p.Username, 1, 255)
		})
	case MethodSSHUnlock:
		return decode(raw, func(p *SSHUnlockParams) error {
			if p.Key == "" {
				return errors.New("key")
			}
			return between("passphrase", p.Passphrase, 1, SSHPassphraseMax)
		})
	case MethodSecretsKeySave:
		return decode(raw, func(p *SecretsKeySaveParams) error {
			if !IsFingerprint(p.Expected) {
				return errors.New("expected")
			}
			return nil
		})
	case MethodSecretsKeyRestore:
		return decode(raw, func(p *SecretsKeyRestoreParams) error {
			if !IsSecretsKeyLine(p.Key) {
				return errors.New("Not a secrets key")
			}
			return nil
		})
	}
	return nil, fmt.Errorf("unknown method %s", method)
}

func checkAuth(a *GitAuth) error {
	switch a.Kind {
	case AuthToken:
		if err := between("username", a.Username, 1, 255); err != nil {
			return err
		}
		return between("password", a.Password, 1, 4096)
	case AuthSSH, AuthNone:
		return nil
	}
	return errors.New("auth kind")
}

// IsWebURL is true for an absolute http(s) URL with a host.
func IsWebURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return false
	}
	return u.Scheme == "http" || u.Scheme == "https"
}

// CleanRemoteURL trims a remote URL and refuses one with a user name or token in it.
func CleanRemoteURL(raw string) (string, bool) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || len(trimmed) > 2048 {
		return "", false
	}
	lower := strings.ToLower(trimmed)
	for _, scheme := range []string{"https://", "http://"} {
		if strings.HasPrefix(lower, scheme) {
			authority, _, _ := strings.Cut(trimmed[len(scheme):], "/")
			if strings.Contains(authority, "@") {
				return "", false
			}
		}
	}
	return trimmed, true
}
