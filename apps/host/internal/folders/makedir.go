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
	if info, err := os.Stat(requested); err == nil && !info.IsDir() {
		return nil, fmt.Errorf("%s is a file, not a folder.", requested)
	}
	if err := os.MkdirAll(requested, 0o755); err != nil {
		return nil, fmt.Errorf("Cannot make %s: %s", requested, errText(err))
	}
	return map[string]string{"path": requested}, nil
}
