package checkout

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"majhi/host/internal/durable"
	"majhi/host/internal/git"
	"majhi/host/internal/protocol"
)

// Release installs name their version and release endpoints in .env. New installs hold only
// runtime setup files and release.json; older installs keep a tagged checkout. Development
// checkouts have no MAJHI_VERSION and build the code on disk. Both release formats retain their
// previous files and settings until the new images start successfully.

const (
	// CheckEvery is how often a release install asks the pointer whether a newer release is out.
	CheckEvery      = 6 * time.Hour
	latestTimeout   = 15 * time.Second
	fetchTimeout    = 60 * time.Second
	checkoutTimeout = 120 * time.Second
)

// LatestFn reads the tag the latest-release pointer at url names. It fails with the reason when it cannot.
type LatestFn func(url string) (string, error)

// ReadLatest is the real LatestFn. The pointer answers GitHub's release object, of which only the tag counts.
func ReadLatest(url string) (string, error) {
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "majhi-host")
	client := &http.Client{Timeout: latestTimeout}
	res, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return "", fmt.Errorf("%s answered %d", url, res.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return "", err
	}
	var body struct {
		TagName string `json:"tag_name"`
	}
	if err := json.Unmarshal(data, &body); err != nil || !IsReleaseTag(body.TagName) {
		return "", fmt.Errorf("%s names no majhi release", url)
	}
	return body.TagName, nil
}

// Release is a tag and its commit.
type Release struct{ Tag, Commit string }

// Installed is what the checkout's `.env` says about its release.
type Installed struct {
	Version string
	// LatestURL is where the latest release is read. Empty: the install stays on its release.
	LatestURL   string
	DownloadURL string
}

// DotenvValue is the last value of name in a `.env` text, without quotes. Empty when unset or empty.
func DotenvValue(dotenv, name string) string {
	found := ""
	for _, line := range strings.Split(strings.ReplaceAll(dotenv, "\r\n", "\n"), "\n") {
		key, value, ok := strings.Cut(line, "=")
		if !ok || strings.TrimSpace(key) != name {
			continue
		}
		value = strings.TrimSpace(value)
		value = strings.TrimPrefix(strings.TrimPrefix(value, `"`), "'")
		value = strings.TrimSuffix(strings.TrimSuffix(value, `"`), "'")
		found = value
	}
	return found
}

// ReleaseIn is the release a `.env` text names. False on a dev checkout.
func ReleaseIn(dotenv string) (Installed, bool) {
	version := DotenvValue(dotenv, "MAJHI_VERSION")
	if version == "" {
		return Installed{}, false
	}
	return Installed{
		Version:     version,
		LatestURL:   DotenvValue(dotenv, "MAJHI_LATEST_URL"),
		DownloadURL: DotenvValue(dotenv, "MAJHI_DOWNLOAD_URL"),
	}, true
}

// WithVersion is the `.env` text with MAJHI_VERSION set to version on the last line, every other line kept.
func WithVersion(dotenv, version string) string {
	var kept []string
	for _, line := range strings.Split(dotenv, "\n") {
		if key, _, ok := strings.Cut(line, "="); ok && strings.TrimSpace(key) == "MAJHI_VERSION" {
			continue
		}
		kept = append(kept, line)
	}
	if len(kept) > 0 && kept[len(kept)-1] == "" {
		kept = kept[:len(kept)-1]
	}
	return strings.Join(append(kept, "MAJHI_VERSION="+version, ""), "\n")
}

func readDotenv(repo string) string {
	data, err := os.ReadFile(filepath.Join(repo, envFile))
	if err != nil {
		return ""
	}
	return string(data)
}

func writeDotenv(repo, text string) error {
	return durable.WriteText(filepath.Join(repo, envFile), text)
}

// tagCommit is the commit tag names in the checkout. "" when the checkout has no such tag.
func tagCommit(ctx Context, tag string) string {
	out, err := ctx.Guarded([]string{"rev-parse", "--verify", "--quiet", "refs/tags/" + tag + "^{commit}"}, false, 0)
	commit := strings.TrimSpace(out)
	if err != nil || !protocol.IsCommit(commit) {
		return ""
	}
	return commit
}

// latestRelease is the release the pointer names, with its commit, read from package metadata or legacy Git tags.
func latestRelease(ctx Context, url string, latest LatestFn) (Release, error) {
	tag, err := latest(url)
	if err != nil {
		return Release{}, err
	}
	pkg, err := ReadPackage(ctx.Repo)
	if err != nil {
		return Release{}, err
	}
	if pkg != nil {
		release, ok := ReleaseIn(readDotenv(ctx.Repo))
		if !ok || release.DownloadURL == "" {
			return Release{}, errors.New("The runtime install names no MAJHI_DOWNLOAD_URL")
		}
		metadata, err := ReadPublishedPackage(release.DownloadURL, tag)
		if err != nil {
			return Release{}, err
		}
		return Release{tag, metadata.Commit}, nil
	}
	if here := tagCommit(ctx, tag); here != "" {
		return Release{tag, here}, nil
	}
	if _, err := ctx.Guarded([]string{"fetch", "--quiet", "--tags", git.UploadPack, "origin"}, false, fetchTimeout); err != nil {
		return Release{}, err
	}
	fetched := tagCommit(ctx, tag)
	if fetched == "" {
		return Release{}, fmt.Errorf("The release %s is not in the checkout's remote", tag)
	}
	return Release{tag, fetched}, nil
}

// TargetReader reads what an update would run, for the version check: a dev checkout's HEAD, or on a
// release install the latest release, asked at most every CheckEvery. A failed ask keeps the last answer.
type TargetReader struct {
	mu      sync.Mutex
	ctx     Context
	now     func() time.Time
	latest  LatestFn
	askedAt time.Time
	asked   bool
	target  *Release
}

// NewTargetReader builds the reader. now and latest are nil for the real ones.
func NewTargetReader(ctx Context, now func() time.Time, latest LatestFn) *TargetReader {
	if now == nil {
		now = time.Now
	}
	if latest == nil {
		latest = ReadLatest
	}
	return &TargetReader{ctx: ctx, now: now, latest: latest}
}

// Read is the state an update would reach.
func (t *TargetReader) Read() (RepoState, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	state, ok := ReadRepo(t.ctx)
	if !ok {
		return RepoState{}, false
	}
	release, installed := ReleaseIn(readDotenv(t.ctx.Repo))
	if !installed || release.LatestURL == "" {
		return state, true
	}
	if !t.asked || t.now().Sub(t.askedAt) >= CheckEvery {
		t.asked, t.askedAt = true, t.now()
		if target, err := latestRelease(t.ctx, release.LatestURL, t.latest); err == nil {
			t.target = &target
		}
	}
	if t.target == nil || t.target.Tag == release.Version {
		return state, true
	}
	state.Commit = t.target.Commit
	return state, true
}

// Moved holds the previous release files and settings, so a failed update can put them back.
type Moved struct {
	From   string            `json:"from"`
	To     string            `json:"to"`
	Head   string            `json:"head"`
	Dotenv string            `json:"dotenv"`
	Files  map[string]string `json:"files,omitempty"`
}

// MoveToLatest updates a release install's runtime files or legacy checkout and `.env`. It returns
// nil on a dev checkout, without a pointer, or when it runs that release already. It fails when the
// pointer or the tag cannot be read; nothing has moved then.
func MoveToLatest(ctx Context, head string, say func(string), latest LatestFn) (*Moved, error) {
	if latest == nil {
		latest = ReadLatest
	}
	dotenv := readDotenv(ctx.Repo)
	release, ok := ReleaseIn(dotenv)
	if !ok {
		return nil, nil
	}
	if release.LatestURL == "" {
		say(".env names no MAJHI_LATEST_URL, so majhi stays on " + release.Version)
		return nil, nil
	}
	say("Looking for the latest release")
	target, err := latestRelease(ctx, release.LatestURL, latest)
	if err != nil {
		return nil, err
	}
	if target.Tag == release.Version {
		return nil, nil
	}
	say("Moving from majhi " + release.Version + " to " + target.Tag)
	pkg, err := ReadPackage(ctx.Repo)
	if err != nil {
		return nil, err
	}
	var files map[string]string
	if pkg != nil {
		if release.DownloadURL == "" {
			return nil, errors.New("The runtime install names no MAJHI_DOWNLOAD_URL")
		}
		files, err = ReplacePackage(ctx, ReleasePackage{Version: target.Tag, Commit: target.Commit}, release.DownloadURL)
		if err != nil {
			return nil, err
		}
	} else if err := checkoutRef(ctx, "refs/tags/"+target.Tag); err != nil {
		return nil, err
	}
	if err := writeDotenv(ctx.Repo, WithVersion(dotenv, target.Tag)); err != nil {
		if files != nil {
			_, _ = RecoverPackage(ctx.Repo)
		} else {
			_ = checkoutRef(ctx, head)
		}
		return nil, err
	}
	return &Moved{From: release.Version, To: target.Tag, Head: head, Dotenv: dotenv, Files: files}, nil
}

// MoveBack restores the runtime files or legacy checkout and `.env`.
func MoveBack(ctx Context, moved Moved) error {
	if moved.Files != nil {
		recovered, err := RecoverPackage(ctx.Repo)
		if err != nil {
			return err
		}
		if !recovered {
			if err := WriteRuntime(ctx.Repo, moved.Files); err != nil {
				return err
			}
		}
	} else if err := checkoutRef(ctx, moved.Head); err != nil {
		return err
	}
	return writeDotenv(ctx.Repo, moved.Dotenv)
}

func checkoutRef(ctx Context, ref string) error {
	_, err := ctx.Guarded([]string{"-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", ref}, true, checkoutTimeout)
	return err
}
