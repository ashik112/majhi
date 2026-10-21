package platform

import (
	"os"
	"path/filepath"
	"strings"
	"time"

	"majhi/host/internal/protocol"
	"majhi/host/internal/run"
	"majhi/host/internal/sys"
)

// WSL2: Linux, with Docker Desktop, the browser, the editor and notifications on the Windows side,
// reached through WSL interop. A Windows program is found on PATH (WSL adds the Windows PATH by
// default), else at its usual place through `wslpath -u`.

const (
	powershellExe = `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`
	explorerExe   = `C:\Windows\explorer.exe`
	clipExe       = `C:\Windows\System32\clip.exe`
	cmdExe        = `C:\Windows\System32\cmd.exe`
	dockerDesktop = `C:\Program Files\Docker\Docker\Docker Desktop.exe`
	wslpathLimit  = 5 * time.Second
	cmdTimeout    = 10 * time.Second
	startTimeout  = 30 * time.Second
)

// notAUser are folders in C:\Users that are not a person's.
var notAUser = map[string]bool{"Public": true, "Default": true, "Default User": true, "All Users": true}

var wslDockerHelp = map[DockerHelpReason]string{
	NotStarted: "Open Docker Desktop in Windows with WSL integration on for this distro, and majhi starts by itself.",
	Slow:       "Docker Desktop did not start in 2 minutes. Open it in Windows, and majhi starts by itself.",
}

// WslPaths say where Windows' C:\Users and WSL's interop sockets show in the distro. Empty: the usual places.
type WslPaths struct {
	UsersDir   string
	InteropDir string
}

// newestInterop is the newest `*_interop` socket in dir, which belongs to the distro's latest session.
func newestInterop(dir string) string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return ""
	}
	newest := ""
	var newestTime time.Time
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), "_interop") {
			continue
		}
		path := filepath.Join(dir, e.Name())
		info, err := os.Stat(path)
		if err != nil || info.Mode()&os.ModeSocket == 0 {
			continue
		}
		if newest == "" || info.ModTime().After(newestTime) {
			newest, newestTime = path, info.ModTime()
		}
	}
	return newest
}

// DistroOf is the distro's name from `wslpath -w /`, which prints `\\wsl.localhost\<name>\` or `\\wsl$\<name>\`.
func DistroOf(windowsRoot string) string {
	root := strings.TrimSpace(windowsRoot)
	lower := strings.ToLower(root)
	for _, prefix := range []string{`\\wsl.localhost\`, `\\wsl$\`} {
		if !strings.HasPrefix(lower, prefix) {
			continue
		}
		rest := root[len(prefix):]
		name, after, _ := strings.Cut(rest, `\`)
		if name != "" && (after == "") {
			return name
		}
	}
	return ""
}

type wslPlatform struct {
	*linuxPlatform
	deps    sys.Deps
	paths   WslPaths
	session func() map[string]string

	distro     string
	powershell string
	userPath   string
}

// NewWSL builds the WSL2 platform.
func NewWSL(deps sys.Deps, paths WslPaths) Platform {
	if paths.UsersDir == "" {
		paths.UsersDir = "/mnt/c/Users"
	}
	if paths.InteropDir == "" {
		paths.InteropDir = "/run/WSL"
	}
	names := append(append([]string{}, LinuxDesktopVars...), "WSL_DISTRO_NAME", "WSL_INTEROP")
	w := &wslPlatform{deps: deps, paths: paths, session: SessionEnv(deps, names)}
	w.linuxPlatform = NewLinux(deps, w.desktopEnv)
	w.linuxPlatform.os = protocol.OSWSL
	w.linuxPlatform.notifier = toastNotifier{run: deps.Run, powershell: w.findPowershell, env: w.desktopEnv}
	return w
}

// wslpath runs `wslpath` with args, or returns "" when it is missing or failed.
func (w *wslPlatform) wslpath(args ...string) string {
	bin := w.deps.Find("wslpath")
	if bin == "" {
		return ""
	}
	result := w.deps.Run(bin, args, run.Options{Env: map[string]string{"PATH": w.deps.Path, "HOME": w.deps.Home}, Timeout: wslpathLimit})
	if result.Code != 0 {
		return ""
	}
	return strings.TrimSpace(result.Stdout)
}

// toLinux is a Windows path as the distro sees it, when something is there.
func (w *wslPlatform) toLinux(windowsPath string) string {
	path := w.wslpath("-u", windowsPath)
	if path != "" && w.deps.Exists(path) {
		return path
	}
	return ""
}

// program is a Windows program on PATH, else at its usual place.
func (w *wslPlatform) program(name, windowsPath string) string {
	if found := w.deps.Find(name); found != "" {
		return found
	}
	return w.toLinux(windowsPath)
}

// desktopEnv is the Linux variables, plus what interop needs. A login service has no WSL_INTEROP, so
// the newest interop socket stands in, and Windows' `code` script needs WSL_DISTRO_NAME to open the distro.
func (w *wslPlatform) desktopEnv() map[string]string {
	env := w.session()
	if env["WSL_INTEROP"] == "" {
		if interop := newestInterop(w.paths.InteropDir); interop != "" {
			env["WSL_INTEROP"] = interop
		}
	}
	if env["WSL_DISTRO_NAME"] == "" {
		if w.distro == "" {
			w.distro = DistroOf(w.wslpath("-w", "/"))
		}
		if w.distro != "" {
			env["WSL_DISTRO_NAME"] = w.distro
		}
	}
	return env
}

func (w *wslPlatform) findPowershell() string {
	if w.powershell == "" {
		w.powershell = w.program("powershell.exe", powershellExe)
	}
	return w.powershell
}

// userFolder is the Windows user's folder: the one person's folder in C:\Users, else %USERPROFILE% from cmd.exe.
func (w *wslPlatform) userFolder() string {
	if w.userPath != "" {
		return w.userPath
	}
	entries, _ := os.ReadDir(w.paths.UsersDir)
	var people []string
	for _, e := range entries {
		// "Default User" and "All Users" are junctions, which show as links, not folders.
		if e.IsDir() && !notAUser[e.Name()] {
			people = append(people, e.Name())
		}
	}
	if len(people) == 1 {
		w.userPath = filepath.Join(w.paths.UsersDir, people[0])
		return w.userPath
	}
	cmd := w.program("cmd.exe", cmdExe)
	if cmd == "" {
		return ""
	}
	// cmd.exe warns about a folder it cannot use unless it starts on a Windows drive.
	result := w.deps.Run(cmd, []string{"/c", "echo", "%USERPROFILE%"},
		run.Options{Env: w.desktopEnv(), Timeout: cmdTimeout, Cwd: filepath.Dir(w.paths.UsersDir)})
	line := ""
	for _, text := range strings.Split(result.Stdout, "\n") {
		text = strings.TrimSpace(text)
		if len(text) >= 3 && isLetter(text[0]) && text[1] == ':' && text[2] == '\\' {
			line = text
			break
		}
	}
	if result.Code != 0 || line == "" {
		return ""
	}
	w.userPath = w.toLinux(line)
	return w.userPath
}

func isLetter(c byte) bool { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') }

type wslEditor struct{ w *wslPlatform }

func (e wslEditor) CLICandidates(app string) []string {
	user := e.w.userFolder()
	programs := ""
	if user != "" {
		programs = filepath.Join(user, "AppData", "Local", "Programs")
	}
	if app == "cursor" {
		if programs == "" {
			return nil
		}
		return []string{filepath.Join(programs, "cursor", "resources", "app", "bin", "cursor")}
	}
	// An install for this user, then one for all users.
	forAll := filepath.Join(filepath.Dir(e.w.paths.UsersDir), "Program Files", "Microsoft VS Code", "bin", "code")
	if programs == "" {
		return []string{forAll}
	}
	return []string{filepath.Join(programs, "Microsoft VS Code", "bin", "code"), forAll}
}

func (e wslEditor) OpenApp(string, string) (bool, bool) { return false, false }

type wslDocker struct{ w *wslPlatform }

func (d wslDocker) Start() bool {
	w := d.w
	app := w.toLinux(dockerDesktop)
	shell := ""
	if app != "" {
		shell = w.findPowershell()
	}
	if shell == "" {
		w.deps.Log("startup: Docker Desktop or powershell.exe was not found")
		return false
	}
	started := w.deps.Run(shell, PowerShellArgs("Start-Process -FilePath '"+dockerDesktop+"'"),
		run.Options{Env: w.desktopEnv(), Timeout: startTimeout})
	if started.Code != 0 {
		w.deps.Log("startup: could not start Docker Desktop")
		return false
	}
	w.deps.Log("startup: started Docker Desktop")
	return true
}

func (d wslDocker) Help(reason DockerHelpReason) string { return wslDockerHelp[reason] }

func (w *wslPlatform) Editor() EditorPlatform        { return wslEditor{w} }
func (w *wslPlatform) Docker() DockerPlatform        { return wslDocker{w} }
func (w *wslPlatform) DesktopEnv() map[string]string { return w.desktopEnv() }
func (w *wslPlatform) OpenURL(url string) bool {
	runner := programRunner{
		run: w.deps.Run,
		find: func(name string) string {
			if name == "explorer.exe" {
				return w.program(name, explorerExe)
			}
			return w.deps.Find(name)
		},
		env: w.desktopEnv,
	}
	return runner.openURL([]string{"wslview", "explorer.exe"}, url)
}
func (w *wslPlatform) ClipboardCopy(text string) bool {
	runner := programRunner{
		run: w.deps.Run,
		find: func(name string) string {
			if name == "clip.exe" {
				return w.program(name, clipExe)
			}
			return w.deps.Find(name)
		},
		env: w.desktopEnv,
	}
	return runner.copyText(append([]ClipboardProgram{{Name: "clip.exe"}}, linuxClipboard...), text)
}
