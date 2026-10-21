package folders

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"majhi/host/internal/protocol"
)

const (
	// SuggestDepth is how many levels below a candidate to look for repos, as the server's scanner does.
	SuggestDepth = 4
	// MaxSuggestions is how many roots are suggested.
	MaxSuggestions = 6
	concurrency    = 32
)

// Budget limits how long and how far a suggestion looks.
type Budget struct {
	// Time stops counting after this long and returns what was counted.
	Time time.Duration
	// Dirs stops after reading this many folders.
	Dirs int
}

// DefaultBudget is two seconds and 20,000 folders.
var DefaultBudget = Budget{Time: 2 * time.Second, Dirs: 20_000}

type step struct {
	root, dir string
	depth     int
}

// SuggestRoots suggests workspace roots: first-level folders of home that hold git repos, with how
// many, most first. Counting follows the server scanner's rules (no hidden folders, no
// `node_modules`, no symlinks, nothing inside a repo) and stops at the budget. skippedAtHome are
// the OS's folders that never hold projects.
func SuggestRoots(home string, skippedAtHome map[string]bool, budget Budget) ([]protocol.RootSuggestion, error) {
	base, err := filepath.EvalSymlinks(home)
	if err != nil {
		base = home
	}
	top, err := os.ReadDir(base)
	if err != nil {
		return nil, err
	}
	var candidates []string
	for _, e := range top {
		if e.IsDir() && !skipped(e.Name()) && !skippedAtHome[e.Name()] {
			candidates = append(candidates, filepath.Join(base, e.Name()))
		}
	}

	var mu sync.Mutex
	counts := make(map[string]int, len(candidates))
	for _, c := range candidates {
		counts[c] = 0
	}
	stopped := false
	read := 0

	// Breadth-first across every candidate at once, so one huge folder cannot use up the
	// budget before the others are looked at.
	walk := func() {
		level := make([]step, len(candidates))
		for i, root := range candidates {
			level[i] = step{root, root, 0}
		}
		for len(level) > 0 {
			mu.Lock()
			done := stopped
			mu.Unlock()
			if done {
				return
			}
			next := make([][]step, len(level))
			var wg sync.WaitGroup
			sem := make(chan struct{}, concurrency)
			for i, item := range level {
				wg.Add(1)
				sem <- struct{}{}
				go func() {
					defer wg.Done()
					defer func() { <-sem }()
					mu.Lock()
					if stopped || read >= budget.Dirs {
						mu.Unlock()
						return
					}
					read++
					mu.Unlock()
					next[i] = scan(item, &mu, &stopped, counts)
				}()
			}
			wg.Wait()
			level = level[:0]
			for _, n := range next {
				level = append(level, n...)
			}
		}
	}
	finished := make(chan struct{})
	go func() {
		walk()
		close(finished)
	}()
	select {
	case <-finished:
	case <-time.After(budget.Time):
	}
	mu.Lock()
	stopped = true
	defer mu.Unlock()

	out := []protocol.RootSuggestion{}
	for path, repoCount := range counts {
		if repoCount > 0 {
			out = append(out, protocol.RootSuggestion{Path: path, RepoCount: repoCount})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].RepoCount != out[j].RepoCount {
			return out[i].RepoCount > out[j].RepoCount
		}
		return out[i].Path < out[j].Path
	})
	if len(out) > MaxSuggestions {
		out = out[:MaxSuggestions]
	}
	return out, nil
}

func scan(item step, mu *sync.Mutex, stopped *bool, counts map[string]int) []step {
	entries, err := os.ReadDir(item.dir)
	if err != nil {
		return nil
	}
	for _, e := range entries {
		if e.Name() != ".git" {
			continue
		}
		if e.IsDir() {
			mu.Lock()
			if !*stopped {
				counts[item.root]++
			}
			mu.Unlock()
		}
		return nil
	}
	if item.depth >= SuggestDepth {
		return nil
	}
	var next []step
	for _, e := range entries {
		if e.IsDir() && !skipped(e.Name()) {
			next = append(next, step{item.root, filepath.Join(item.dir, e.Name()), item.depth + 1})
		}
	}
	return next
}

// skipped: hidden folders and `node_modules` are never scanned, as in the server's scanner.
func skipped(name string) bool { return strings.HasPrefix(name, ".") || name == "node_modules" }
