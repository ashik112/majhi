// Package folders browses the owner's folders for the folder picker: listing, making and suggesting.
package folders

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"unicode"
	"unicode/utf8"

	"majhi/host/internal/paths"
	"majhi/host/internal/protocol"
)

// MaxEntries is how many folders a listing holds. Beyond that the listing says `truncated`.
const MaxEntries = 500

// hiddenAtHome is never offered at the top of home: system data, not projects.
const hiddenAtHome = "Library"

type candidate struct {
	name   string
	path   string
	target string
	hidden bool
}

// ListDirs lists the subfolders of path (`~` expands to home), sorted by name without regard to case.
// Symlinks to folders are listed under their own name. It fails with a message fit to show.
func ListDirs(params protocol.ListDirsParams, home string) (protocol.DirListing, error) {
	requested := paths.ExpandHome(params.Path, home)
	if !filepath.IsAbs(requested) {
		return protocol.DirListing{}, errors.New("Use an absolute path, or one starting with ~/")
	}
	dir, err := filepath.EvalSymlinks(requested)
	if err != nil {
		return protocol.DirListing{}, describeError(err, requested)
	}
	info, err := os.Stat(dir)
	if err != nil {
		return protocol.DirListing{}, describeError(err, requested)
	}
	if !info.IsDir() {
		return protocol.DirListing{}, fmt.Errorf("%s is not a folder", requested)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return protocol.DirListing{}, describeError(err, requested)
	}
	realHome, err := filepath.EvalSymlinks(home)
	if err != nil {
		realHome = home
	}

	var found []candidate
	for _, entry := range entries {
		hidden := strings.HasPrefix(entry.Name(), ".")
		if hidden && !params.ShowHidden {
			continue
		}
		if dir == realHome && entry.Name() == hiddenAtHome {
			continue
		}
		path := filepath.Join(dir, entry.Name())
		switch {
		case entry.IsDir():
			found = append(found, candidate{entry.Name(), path, path, hidden})
		case entry.Type()&fs.ModeSymlink != 0:
			if target, ok := folderBehind(path); ok {
				found = append(found, candidate{entry.Name(), path, target, hidden})
			}
		}
	}
	sort.SliceStable(found, func(i, j int) bool {
		if c := compareNames(found[i].name, found[j].name); c != 0 {
			return c < 0
		}
		return found[i].name < found[j].name
	})
	kept := found
	if len(kept) > MaxEntries {
		kept = kept[:MaxEntries]
	}
	listed := make([]protocol.DirEntry, len(kept))
	for i, c := range kept {
		listed[i] = protocol.DirEntry{Name: c.name, Path: c.path, IsRepo: hasGitDir(c.target), Hidden: c.hidden}
	}
	var parent *string
	if dir != "/" {
		p := filepath.Dir(dir)
		parent = &p
	}
	return protocol.DirListing{
		Path:      dir,
		Parent:    parent,
		Home:      realHome,
		Entries:   listed,
		Truncated: len(found) > len(kept),
	}, nil
}

// folderBehind is the real folder a symlink points to. False for a broken link or a link to a file.
func folderBehind(link string) (string, bool) {
	target, err := filepath.EvalSymlinks(link)
	if err != nil {
		return "", false
	}
	info, err := os.Stat(target)
	if err != nil || !info.IsDir() {
		return "", false
	}
	return target, true
}

// hasGitDir is true when dir/.git is a real directory. A `.git` file (worktree, submodule) or symlink does not count.
func hasGitDir(dir string) bool {
	info, err := os.Lstat(filepath.Join(dir, ".git"))
	return err == nil && info.IsDir()
}

func describeError(err error, path string) error {
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return fmt.Errorf("There is no folder at %s", path)
	case errors.Is(err, syscall.ENOTDIR):
		return fmt.Errorf("%s is not a folder", path)
	case errors.Is(err, fs.ErrPermission):
		return fmt.Errorf("majhi does not have permission to read %s", path)
	case errors.Is(err, syscall.ELOOP):
		return fmt.Errorf("%s is a symlink that points back to itself", path)
	}
	return fmt.Errorf("Cannot read %s: %s", path, errText(err))
}

// errText is the reason of a file error without the path Go puts in front of it.
func errText(err error) string {
	var pe *fs.PathError
	if errors.As(err, &pe) {
		return pe.Err.Error()
	}
	return err.Error()
}

// compareNames orders names without regard to case, with runs of digits compared as numbers, so
// `app2` comes before `app10`. Punctuation sorts before digits, and digits before letters.
func compareNames(a, b string) int {
	a, b = strings.ToLower(a), strings.ToLower(b)
	for a != "" && b != "" {
		ra, _ := utf8.DecodeRuneInString(a)
		rb, _ := utf8.DecodeRuneInString(b)
		if unicode.IsDigit(ra) && unicode.IsDigit(rb) {
			na, restA := digits(a)
			nb, restB := digits(b)
			if c := compareNumbers(na, nb); c != 0 {
				return c
			}
			a, b = restA, restB
			continue
		}
		if ca, cb := rank(ra), rank(rb); ca != cb {
			return ca - cb
		}
		if ra != rb {
			if ra < rb {
				return -1
			}
			return 1
		}
		a, b = a[utf8.RuneLen(ra):], b[utf8.RuneLen(rb):]
	}
	return len(a) - len(b)
}

func rank(r rune) int {
	switch {
	case unicode.IsLetter(r):
		return 2
	case unicode.IsDigit(r):
		return 1
	}
	return 0
}

func digits(s string) (run, rest string) {
	end := 0
	for end < len(s) && s[end] >= '0' && s[end] <= '9' {
		end++
	}
	return s[:end], s[end:]
}

func compareNumbers(a, b string) int {
	a, b = strings.TrimLeft(a, "0"), strings.TrimLeft(b, "0")
	if len(a) != len(b) {
		return len(a) - len(b)
	}
	return strings.Compare(a, b)
}
