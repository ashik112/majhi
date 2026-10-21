//go:build windows

package run

import (
	"os/exec"
	"syscall"
)

const createNewProcessGroup = 0x00000200

// configure puts the program in its own process group. Windows native is not supported by the helper
// yet (docs/DECISIONS.md); this only keeps the package building for it.
func configure(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: createNewProcessGroup}
}

func killGroup(cmd *exec.Cmd, _ bool) {
	_ = cmd.Process.Kill()
}
