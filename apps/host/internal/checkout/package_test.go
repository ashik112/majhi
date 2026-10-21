package checkout

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"majhi/host/internal/run"
)

const (
	oldCommit = "1111111111111111111111111111111111111111"
	newCommit = "2222222222222222222222222222222222222222"
)

func installRepo(t *testing.T) string {
	t.Helper()
	repo := filepath.Join(t.TempDir(), "majhi")
	for _, name := range append(append([]string{}, RuntimeFiles...), ".env") {
		path := filepath.Join(repo, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("old "+name), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	release := `{"version":"v1.0.0","commit":"` + oldCommit + `"}`
	if err := os.WriteFile(filepath.Join(repo, "release.json"), []byte(release), 0o644); err != nil {
		t.Fatal(err)
	}
	return repo
}

// install stands for install.sh: it lays a package down in MAJHI_APP_DIR.
func install(version, commit string) run.Func {
	return func(file string, args []string, o run.Options) run.Result {
		app := o.Env["MAJHI_APP_DIR"]
		for _, name := range RuntimeFiles {
			path := filepath.Join(app, name)
			_ = os.MkdirAll(filepath.Dir(path), 0o755)
			_ = os.WriteFile(path, []byte("new "+name), 0o644)
		}
		_ = os.WriteFile(filepath.Join(app, "release.json"), []byte(`{"version":"`+version+`","commit":"`+commit+`"}`), 0o644)
		return run.Result{}
	}
}

func contents(t *testing.T, repo, name string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(repo, name))
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

// A package that does not match the published release is refused, and nothing installed changes
// (guarantee: release checks).
func TestReleaseThatDoesNotMatchWhatWasPublishedIsRefused(t *testing.T) {
	for _, c := range []struct{ name, version, commit string }{
		{"another commit", "v1.1.0", oldCommit},
		{"another version", "v1.0.1", newCommit},
	} {
		t.Run(c.name, func(t *testing.T) {
			repo := installRepo(t)
			ctx := Context{Repo: repo, Run: install(c.version, c.commit), Env: map[string]string{}}
			_, err := ReplacePackage(ctx, ReleasePackage{Version: "v1.1.0", Commit: newCommit}, "https://example.test/releases")
			if err == nil || !strings.Contains(err.Error(), "does not match the published release") {
				t.Fatalf("%v", err)
			}
			for _, name := range RuntimeFiles[:len(RuntimeFiles)-1] {
				if contents(t, repo, name) != "old "+name {
					t.Fatalf("%s changed", name)
				}
			}
			if _, err := os.Stat(filepath.Join(repo, rollbackFile)); !os.IsNotExist(err) {
				t.Fatal("a rollback file was left")
			}
		})
	}
}

// A package that matches replaces the runtime files, and the rollback file puts every original back,
// also after an interrupted restore.
func TestReleaseThatMatchesIsReplacedAndRolledBack(t *testing.T) {
	repo := installRepo(t)
	ctx := Context{Repo: repo, Run: install("v1.1.0", newCommit), Env: map[string]string{}}
	previous, err := ReplacePackage(ctx, ReleasePackage{Version: "v1.1.0", Commit: newCommit}, "https://example.test/releases")
	if err != nil {
		t.Fatal(err)
	}
	if previous["Dockerfile"] != "old Dockerfile" || contents(t, repo, "Dockerfile") != "new Dockerfile" {
		t.Fatalf("%v", previous)
	}
	if contents(t, repo, ".env") != "old .env" {
		t.Fatal(".env changed")
	}
	// The helper stops before the update ends. At the next start the originals come back.
	recovered, err := RecoverPackage(repo)
	if err != nil || !recovered {
		t.Fatalf("%v %v", recovered, err)
	}
	for _, name := range RuntimeFiles {
		want := "old " + name
		if name == "release.json" {
			want = `{"version":"v1.0.0","commit":"` + oldCommit + `"}`
		}
		if contents(t, repo, name) != want {
			t.Fatalf("%s was not put back: %q", name, contents(t, repo, name))
		}
	}
	if again, _ := RecoverPackage(repo); again {
		t.Fatal("recovery ran twice")
	}
}

// A runtime file that is a link, or sits behind one, is never written through.
func TestReleaseNeverWritesThroughALink(t *testing.T) {
	repo := installRepo(t)
	outside := filepath.Join(t.TempDir(), "outside")
	if err := os.WriteFile(outside, []byte("precious"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(repo, "LICENSE")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(repo, "LICENSE")); err != nil {
		t.Fatal(err)
	}
	ctx := Context{Repo: repo, Run: install("v1.1.0", newCommit), Env: map[string]string{}}
	if _, err := ReplacePackage(ctx, ReleasePackage{Version: "v1.1.0", Commit: newCommit}, "https://example.test/releases"); err == nil ||
		!strings.Contains(err.Error(), "symbolic link") {
		t.Fatalf("%v", err)
	}
	if data, _ := os.ReadFile(outside); string(data) != "precious" {
		t.Fatal("the file behind the link changed")
	}
}
