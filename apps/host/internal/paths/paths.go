// Package paths holds the small path rules the helper shares: `~` expansion and the tool folders
// a login service's PATH may lack.
package paths

import (
	"os"
	"path/filepath"
	"strings"
)

// ExpandHome expands a leading `~` against home. Absolute paths are left alone.
func ExpandHome(path, home string) string {
	trimmed := strings.TrimSpace(path)
	if trimmed == "~" {
		return stripTrailingSlash(home)
	}
	if strings.HasPrefix(trimmed, "~/") {
		return stripTrailingSlash(stripTrailingSlash(home) + "/" + trimmed[2:])
	}
	return stripTrailingSlash(trimmed)
}

// CollapseHome replaces a leading home with `~` for display.
func CollapseHome(path, home string) string {
	base := stripTrailingSlash(home)
	if path == base {
		return "~"
	}
	if strings.HasPrefix(path, base+"/") {
		return "~" + path[len(base):]
	}
	return path
}

func stripTrailingSlash(p string) string {
	if len(p) > 1 && strings.HasSuffix(p, "/") {
		return strings.TrimRight(p, "/")
	}
	return p
}

// ToolDirs are the folders where docker, git and the editor CLIs live that a login service's PATH may lack.
func ToolDirs(os string, home string) []string {
	if os == "macos" {
		return []string{"/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"}
	}
	return []string{"/usr/local/bin", "/usr/bin", "/bin", "/snap/bin", filepath.Join(home, ".local", "bin")}
}

// ToolPath is the current PATH with the OS's usual tool folders added, each folder once.
func ToolPath(current, os, home string) string {
	var out []string
	seen := map[string]bool{}
	add := func(dir string) {
		if dir == "" || seen[dir] {
			return
		}
		seen[dir] = true
		out = append(out, dir)
	}
	for _, dir := range strings.Split(current, ":") {
		add(dir)
	}
	for _, dir := range ToolDirs(os, home) {
		add(dir)
	}
	return strings.Join(out, ":")
}

// FindExecutable returns the absolute path of the first executable `name` on path, or "".
func FindExecutable(name, path string) string {
	for _, dir := range strings.Split(path, ":") {
		if dir == "" {
			continue
		}
		candidate := filepath.Join(dir, name)
		if IsExecutable(candidate) {
			return candidate
		}
	}
	return ""
}

// IsExecutable is true for a regular file the owner may run.
func IsExecutable(path string) bool {
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return false
	}
	return info.Mode().Perm()&0o111 != 0
}

// Exists is true when something is at path.
func Exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
