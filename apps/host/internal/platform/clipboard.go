package platform

import (
	"time"

	"majhi/host/internal/run"
)

const copyTimeout = 8 * time.Second

// ClipboardProgram is a program that takes text on stdin and puts it on the clipboard.
type ClipboardProgram struct {
	Name string
	Args []string
}

// The programs each OS tries, in order.
var (
	macClipboard   = []ClipboardProgram{{Name: "pbcopy"}}
	linuxClipboard = []ClipboardProgram{
		{Name: "wl-copy"},
		{Name: "xclip", Args: []string{"-selection", "clipboard"}},
		{Name: "xsel", Args: []string{"--clipboard", "--input"}},
	}
)

// programRunner is what a clipboard or browser call needs.
type programRunner struct {
	run  run.Func
	find func(name string) string
	env  func() map[string]string
}

// copyText puts text on the clipboard with the first program that works. The text goes to the
// program's stdin and nowhere else: not its arguments (they show in `ps`), not the log, not an error.
func (r programRunner) copyText(programs []ClipboardProgram, text string) bool {
	for _, program := range programs {
		bin := r.find(program.Name)
		if bin == "" {
			continue
		}
		env := map[string]string{"LANG": "en_US.UTF-8"} // pbcopy reads bytes as UTF-8 only when the locale says so.
		for k, v := range r.env() {
			env[k] = v
		}
		result := r.run(bin, program.Args, run.Options{Env: env, Timeout: copyTimeout, Input: text})
		if result.Code == 0 {
			return true
		}
	}
	return false
}
