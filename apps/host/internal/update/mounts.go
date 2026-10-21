package update

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"go.yaml.in/yaml/v3"
)

// The journal keeps the compose override (`docker-compose.override.yml`) the update replaced, and a
// rollback writes it back. The override is what `gen-override` makes: bind mounts of the workspace
// roots, the SSH public keys and the agent socket, and the GPU for Laya (apps/server/src/cli/genOverride.ts).
// A journal that names anything else is refused, so a planted file can never mount the computer's
// root, the Docker socket or the owner's home into majhi.

// agentTarget is where an agent socket from outside `~/.majhi` is mounted in the server.
const agentTarget = "/run/ssh-agent.sock"

// systemRoots are folders that hold the operating system, never mounted (as in packages/shared/src/paths.ts).
var systemRoots = []string{
	"/bin", "/boot", "/dev", "/etc", "/lib", "/lib64", "/proc", "/sbin", "/sys", "/usr", "/var",
	"/System", "/Library", "/Applications", "/private",
}

func isSystemFolder(path string) bool {
	clean := filepath.Clean(path)
	if clean == "/" || clean == "/Users" || clean == "/home" {
		return true
	}
	for _, prefix := range []string{"/private/tmp", "/private/var/folders", "/var/folders"} {
		if clean == prefix || strings.HasPrefix(clean, prefix+"/") {
			return false
		}
	}
	for _, root := range systemRoots {
		if clean == root || strings.HasPrefix(clean, root+"/") {
			return true
		}
	}
	return false
}

func isBelow(path, folder string) bool {
	rel, err := filepath.Rel(folder, path)
	return err == nil && rel != "." && rel != ".." && !strings.HasPrefix(rel, "../")
}

type mount struct{ source, target string }

type override struct {
	Services map[string]map[string]any `yaml:"services"`
}

// overrideMounts reads the bind mounts of an override and refuses anything it does not recognise.
func overrideMounts(text string) ([]mount, error) {
	var top map[string]any
	if err := yaml.Unmarshal([]byte(text), &top); err != nil {
		return nil, fmt.Errorf("the saved mounts are not YAML")
	}
	for key := range top {
		if key != "services" {
			return nil, fmt.Errorf("the saved mounts hold %q", key)
		}
	}
	var o override
	if err := yaml.Unmarshal([]byte(text), &o); err != nil {
		return nil, fmt.Errorf("the saved mounts are not an override")
	}
	var out []mount
	for name, service := range o.Services {
		allowed := map[string]bool{}
		switch name {
		case "server":
			allowed = map[string]bool{"volumes": true, "environment": true, "group_add": true}
		case "laya":
			allowed = map[string]bool{"environment": true, "deploy": true}
		default:
			return nil, fmt.Errorf("the saved mounts hold the service %q", name)
		}
		for key, value := range service {
			if !allowed[key] {
				return nil, fmt.Errorf("the saved mounts set %q on %q", key, name)
			}
			if key != "volumes" {
				continue
			}
			list, ok := value.([]any)
			if !ok {
				return nil, fmt.Errorf("the saved volumes are not a list")
			}
			for _, entry := range list {
				m, err := parseVolume(entry)
				if err != nil {
					return nil, err
				}
				out = append(out, m)
			}
		}
	}
	return out, nil
}

func parseVolume(entry any) (mount, error) {
	switch v := entry.(type) {
	case string:
		parts := strings.Split(v, ":")
		if len(parts) < 2 || len(parts) > 3 {
			return mount{}, fmt.Errorf("a saved mount is not source:target")
		}
		if len(parts) == 3 && parts[2] != "ro" && parts[2] != "rw" {
			return mount{}, fmt.Errorf("a saved mount has options majhi does not make")
		}
		return mount{parts[0], parts[1]}, nil
	case map[string]any:
		source, _ := v["source"].(string)
		target, _ := v["target"].(string)
		if v["type"] != "bind" || source == "" || target == "" {
			return mount{}, fmt.Errorf("a saved mount is not a bind mount")
		}
		for key := range v {
			switch key {
			case "type", "source", "target", "read_only":
			default:
				return mount{}, fmt.Errorf("a saved mount sets %q", key)
			}
		}
		return mount{source, target}, nil
	}
	return mount{}, fmt.Errorf("a saved mount is not a mount")
}

// CheckMounts says why a saved override must not be written back, or "" when it may. A source must be
// an absolute, clean path outside the operating system's folders, and either strictly inside the
// owner's home, exactly a source the override on disk mounts now, or the agent socket's own mount.
func CheckMounts(text, home string, current []string) string {
	mounts, err := overrideMounts(text)
	if err != nil {
		return err.Error()
	}
	known := map[string]bool{}
	for _, c := range current {
		known[c] = true
	}
	for _, m := range mounts {
		if !filepath.IsAbs(m.source) || filepath.Clean(m.source) != m.source || strings.ContainsAny(m.source, "\n\r\x00") {
			return fmt.Sprintf("a saved mount names %q, which is not a plain absolute path", m.source)
		}
		if isSystemFolder(m.source) {
			return fmt.Sprintf("a saved mount names %q, a system folder", m.source)
		}
		switch {
		case m.target == agentTarget:
		case home != "" && isBelow(m.source, filepath.Clean(home)):
		case known[m.source]:
		default:
			return fmt.Sprintf("a saved mount names %q, which majhi does not mount", m.source)
		}
	}
	return ""
}

// currentSources are the bind sources of the override on disk now, for CheckMounts.
func currentSources(repo string) []string {
	data, err := os.ReadFile(filepath.Join(repo, OverrideFile))
	if err != nil {
		return nil
	}
	mounts, err := overrideMounts(string(data))
	if err != nil {
		return nil
	}
	out := make([]string, 0, len(mounts))
	for _, m := range mounts {
		out = append(out, m.source)
	}
	return out
}
