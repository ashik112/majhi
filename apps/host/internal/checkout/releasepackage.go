package checkout

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"majhi/host/internal/download"
	"majhi/host/internal/durable"
	"majhi/host/internal/run"
)

// RuntimeFiles are the files of a release install that an update replaces.
var RuntimeFiles = []string{
	"Dockerfile",
	"docker-compose.yml",
	"docker/owner.sh",
	"docker/laya.Dockerfile",
	"scripts/check.sh",
	"scripts/compose.sh",
	"scripts/host.sh",
	"scripts/lib.sh",
	"scripts/up.sh",
	"install.sh",
	"LICENSE",
	"release.json",
}

const (
	rollbackFile = ".majhi-runtime-rollback.json"
	envFile      = ".env"
)

// ReleasePackage is the metadata shipped with the runtime package and published beside it.
type ReleasePackage struct {
	Version string `json:"version"`
	Commit  string `json:"commit"`
}

// IsReleaseTag is `v<major>.<minor>.<patch>`.
func IsReleaseTag(s string) bool {
	rest, ok := strings.CutPrefix(s, "v")
	if !ok {
		return false
	}
	parts := strings.Split(rest, ".")
	if len(parts) != 3 {
		return false
	}
	for _, p := range parts {
		if p == "" {
			return false
		}
		for _, r := range p {
			if r < '0' || r > '9' {
				return false
			}
		}
	}
	return true
}

func isFullCommit(s string) bool {
	if len(s) < 40 || len(s) > 64 {
		return false
	}
	for _, r := range s {
		if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f')) {
			return false
		}
	}
	return true
}

func parsePackage(data []byte) (ReleasePackage, error) {
	var pkg ReleasePackage
	if err := json.Unmarshal(data, &pkg); err != nil {
		return ReleasePackage{}, fmt.Errorf("release.json is not valid: %w", err)
	}
	if !IsReleaseTag(pkg.Version) || !isFullCommit(pkg.Commit) {
		return ReleasePackage{}, errors.New("release.json is not valid")
	}
	return pkg, nil
}

// ReadPackage reads the runtime package's metadata. It returns nil only when this is a source
// checkout. Invalid package metadata fails closed.
func ReadPackage(repo string) (*ReleasePackage, error) {
	data, err := os.ReadFile(filepath.Join(repo, "release.json"))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	pkg, err := parsePackage(data)
	if err != nil {
		return nil, err
	}
	return &pkg, nil
}

// ReadPublishedPackage reads the metadata a release published at base/<version>/release.json.
func ReadPublishedPackage(base, version string) (ReleasePackage, error) {
	// Validate the version before it can become a path component.
	if !IsReleaseTag(version) {
		return ReleasePackage{}, errors.New("The release version is not valid")
	}
	if err := download.CheckURL(base); err != nil {
		return ReleasePackage{}, fmt.Errorf("MAJHI_DOWNLOAD_URL: %w", err)
	}
	res, err := download.Client(15 * time.Second).Get(strings.TrimSuffix(base, "/") + "/" + version + "/release.json")
	if err != nil {
		return ReleasePackage{}, err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return ReleasePackage{}, fmt.Errorf("The release metadata answered %d", res.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return ReleasePackage{}, err
	}
	pkg, err := parsePackage(data)
	if err != nil {
		return ReleasePackage{}, err
	}
	if pkg.Version != version {
		return ReleasePackage{}, errors.New("The release metadata names another version")
	}
	return pkg, nil
}

// regularDestination refuses symlink destinations, including parents, before replacing runtime files.
func regularDestination(repo, file string) error {
	paths := []string{repo}
	if strings.Contains(file, "/") {
		paths = append(paths, filepath.Join(repo, filepath.Dir(file)))
	}
	last := filepath.Join(repo, file)
	paths = append(paths, last)
	for _, path := range paths {
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("The runtime path is a symbolic link: %s", file)
		}
		if path == last && !info.Mode().IsRegular() {
			return fmt.Errorf("The runtime file is not regular: %s", file)
		}
	}
	return nil
}

func allowedRuntimeKey(name string) bool {
	if name == envFile {
		return true
	}
	for _, f := range RuntimeFiles {
		if f == name {
			return true
		}
	}
	return false
}

// CheckRuntimeFiles refuses a file name that is not one of the runtime files (or `.env`).
func CheckRuntimeFiles(files map[string]string) error {
	for name := range files {
		if !allowedRuntimeKey(name) {
			return fmt.Errorf("%q is not a runtime file", name)
		}
	}
	return nil
}

// WriteRuntime replaces the runtime files, each in the safe order (durable.WriteText).
func WriteRuntime(repo string, files map[string]string) error {
	names := make([]string, 0, len(files))
	for name := range files {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if err := regularDestination(repo, name); err != nil {
			return err
		}
		if err := durable.WriteText(filepath.Join(repo, name), files[name]); err != nil {
			return err
		}
	}
	return nil
}

type rollback struct {
	Version int               `json:"version"`
	Files   map[string]string `json:"files"`
}

// RecoverPackage restores every original file, even if the previous restore was interrupted. It
// returns false when there was nothing to recover.
func RecoverPackage(repo string) (bool, error) {
	data, err := os.ReadFile(filepath.Join(repo, rollbackFile))
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	var journal rollback
	if err := json.Unmarshal(data, &journal); err != nil || journal.Version != 1 || CheckRuntimeFiles(journal.Files) != nil {
		return false, errors.New("The runtime rollback file is not valid")
	}
	if err := WriteRuntime(repo, journal.Files); err != nil {
		return false, err
	}
	return true, CommitPackage(repo)
}

// CommitPackage removes the rollback file: the installed release is committed.
func CommitPackage(repo string) error { return durable.Remove(filepath.Join(repo, rollbackFile)) }

// ReplacePackage downloads and validates the target release before changing any installed file, and
// keeps the old files for an update rollback.
func ReplacePackage(ctx Context, target ReleasePackage, downloadURL string) (map[string]string, error) {
	if err := download.CheckURL(downloadURL); err != nil {
		return nil, fmt.Errorf("MAJHI_DOWNLOAD_URL: %w", err)
	}
	if _, err := RecoverPackage(ctx.Repo); err != nil {
		return nil, err
	}
	previous := map[string]string{}
	for _, file := range append(append([]string{}, RuntimeFiles...), envFile) {
		if err := regularDestination(ctx.Repo, file); err != nil {
			return nil, err
		}
		data, err := os.ReadFile(filepath.Join(ctx.Repo, file))
		if err != nil {
			return nil, err
		}
		previous[file] = string(data)
	}
	stage, err := os.MkdirTemp(filepath.Dir(ctx.Repo), ".majhi-update-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(stage)
	app := filepath.Join(stage, "app")
	env := mergeEnv(ctx.Env, map[string]string{
		"MAJHI_APP_DIR":      app,
		"MAJHI_VERSION":      target.Version,
		"MAJHI_DOWNLOAD_URL": downloadURL,
		"MAJHI_INSTALL_ONLY": "1",
	})
	res := ctx.Run("/bin/sh", []string{filepath.Join(ctx.Repo, "install.sh")}, run.Options{
		Env: env, Cwd: ctx.Repo, Timeout: 6 * time.Minute, MaxOutput: 1 << 20, Tail: true,
	})
	if res.Code != 0 {
		return nil, errors.New("The release package could not be downloaded: " + lastLine(res.Stderr))
	}
	downloaded, err := ReadPackage(app)
	if err != nil {
		return nil, err
	}
	if downloaded == nil || downloaded.Version != target.Version || downloaded.Commit != target.Commit {
		return nil, errors.New("The downloaded package does not match the published release")
	}
	files := map[string]string{}
	for _, file := range RuntimeFiles {
		data, err := os.ReadFile(filepath.Join(app, file))
		if err != nil {
			return nil, err
		}
		files[file] = string(data)
	}
	journal, err := json.Marshal(rollback{Version: 1, Files: previous})
	if err != nil {
		return nil, err
	}
	if err := durable.WriteText(filepath.Join(ctx.Repo, rollbackFile), string(journal)); err != nil {
		return nil, err
	}
	if err := WriteRuntime(ctx.Repo, files); err != nil {
		if _, recoverErr := RecoverPackage(ctx.Repo); recoverErr != nil {
			return nil, recoverErr
		}
		return nil, err
	}
	return previous, nil
}

func lastLine(text string) string {
	lines := strings.Split(strings.TrimSpace(text), "\n")
	line := lines[len(lines)-1]
	if line == "" {
		return "no details"
	}
	return line
}
