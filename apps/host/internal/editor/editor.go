// Package editor opens a file or folder in VS Code or Cursor. The program is run directly, never
// through a shell, and the path must be absolute and exist, so it cannot be read as an option.
// Messages are fixed sentences: the editor's own output is not passed on.
package editor

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"majhi/host/internal/paths"
	"majhi/host/internal/platform"
	"majhi/host/internal/protocol"
	"majhi/host/internal/run"
)

const openTimeout = 15 * time.Second

var (
	label = map[string]string{"vscode": "VS Code", "cursor": "Cursor"}
	// cli is the shell command each editor installs.
	cli = map[string]string{"vscode": "code", "cursor": "cursor"}
)

// Deps are what the editor opener needs.
type Deps struct {
	Run run.Func
	// Platform says where the command may be when it is not on PATH, and the app to open where there is one.
	Platform platform.EditorPlatform
	// Env is `DesktopEnv()`: what the editor needs to show its window.
	Env func() map[string]string
	// Find is the absolute path of the first executable `name` on the helper's PATH, or "".
	Find func(name string) string
	// Kind is the kind of thing at path: "file", "directory", or "" when there is nothing there.
	Kind func(path string) string
	// IsExecutable is true when the executable exists.
	IsExecutable func(path string) bool
}

// Opener opens paths in an editor.
type Opener struct{ d Deps }

// New builds the opener.
func New(d Deps) *Opener { return &Opener{d} }

// Open opens the path. It fails with a fixed sentence.
func (o *Opener) Open(p protocol.EditorOpenParams) error {
	name := label[p.App]
	if !filepath.IsAbs(p.Path) || strings.Contains(p.Path, "\x00") {
		return errors.New("The path must be absolute.")
	}
	kind := o.d.Kind(p.Path)
	if kind == "" {
		return fmt.Errorf("There is nothing at %s on this computer.", p.Path)
	}
	if bin := o.findCLI(p.App); bin != "" {
		args := []string{p.Path}
		if p.Line != nil && kind == "file" {
			args = []string{"--goto", fmt.Sprintf("%s:%d", p.Path, *p.Line)}
		}
		if o.d.Run(bin, args, run.Options{Env: o.d.Env(), Timeout: openTimeout}).Code == 0 {
			return nil
		}
		return fmt.Errorf("%s did not open %s.", name, p.Path)
	}
	opened, supported := o.d.Platform.OpenApp(p.App, p.Path)
	if !supported {
		return fmt.Errorf("%s is not installed, or its `%s` command is not on the PATH.", name, cli[p.App])
	}
	if !opened {
		return fmt.Errorf("%s is not installed, so %s was not opened.", name, p.Path)
	}
	return nil
}

func (o *Opener) findCLI(app string) string {
	if onPath := o.d.Find(cli[app]); onPath != "" {
		return onPath
	}
	for _, candidate := range o.d.Platform.CLICandidates(app) {
		if o.d.IsExecutable(candidate) {
			return candidate
		}
	}
	return ""
}

// PathKind is the real Kind.
func PathKind(path string) string {
	info, err := os.Stat(path)
	switch {
	case err != nil:
		return ""
	case info.IsDir():
		return "directory"
	}
	return "file"
}

// IsExecutableFile is the real IsExecutable.
func IsExecutableFile(file string) bool {
	return paths.FindExecutable(filepath.Base(file), filepath.Dir(file)) != ""
}
