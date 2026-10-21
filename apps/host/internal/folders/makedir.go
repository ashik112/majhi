package folders

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"majhi/host/internal/paths"
	"majhi/host/internal/protocol"
)

// MakeDir makes a project folder (and the folders above it) under the owner's home. Anywhere else is
// refused, and an existing folder is left as it is. It fails with a message fit to show.
func MakeDir(params protocol.PathParams, home string) (map[string]string, error) {
	expanded := paths.ExpandHome(params.Path, home)
	if !filepath.IsAbs(expanded) {
		return nil, errors.New("Use an absolute path, or one starting with ~/")
	}
	requested := filepath.Clean(expanded)
	rel, err := filepath.Rel(filepath.Clean(home), requested)
	if err != nil || rel == "." || strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
		return nil, errors.New("majhi only makes folders inside your home folder.")
	}
	// A link on the way (`~/link/x` with `link` pointing outside) must not lead out of the home either:
	// the longest part that exists is resolved, and the whole is checked again.
	if !insideHome(requested, home) {
		return nil, errors.New("majhi only makes folders inside your home folder.")
	}
	if info, err := os.Stat(requested); err == nil && !info.IsDir() {
		return nil, fmt.Errorf("%s is a file, not a folder.", requested)
	}
	if err := os.MkdirAll(requested, 0o755); err != nil {
		return nil, fmt.Errorf("Cannot make %s: %s", requested, errText(err))
	}
	return map[string]string{"path": requested}, nil
}

// insideHome resolves the symlinks on the longest existing prefix of path and says whether the result
// is still strictly inside the home, itself resolved.
func insideHome(path, home string) bool {
	realHome, err := filepath.EvalSymlinks(filepath.Clean(home))
	if err != nil {
		return false
	}
	existing, rest := path, ""
	for {
		if _, err := os.Lstat(existing); err == nil {
			break
		}
		parent := filepath.Dir(existing)
		if parent == existing {
			return false
		}
		rest = filepath.Join(filepath.Base(existing), rest)
		existing = parent
	}
	real, err := filepath.EvalSymlinks(existing)
	if err != nil {
		return false
	}
	rel, err := filepath.Rel(realHome, filepath.Join(real, rest))
	return err == nil && rel != "." && rel != ".." && !strings.HasPrefix(rel, "../") && !filepath.IsAbs(rel)
}
