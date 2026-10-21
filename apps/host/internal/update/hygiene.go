package update

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"majhi/host/internal/protocol"
)

// What an update removes of majhi's own old images once the new majhi runs. Only things majhi
// labelled: the `majhi-server:previous` / `majhi-laya:previous` tags, images carrying
// `majhi.container=image` (a preview, or an image a script built) whose task (`majhi.task`) is done
// or gone, and dangling images that carry a majhi label. The builders and volumes of the old
// per-task model are removed by the server itself when it starts, by task id. Never another
// project's images, volumes or containers, and never the build cache beyond its age cap.

// MajhiImageLabels are what images carry: previews and script builds, and the images compose builds.
var MajhiImageLabels = []string{"majhi.container=image", "majhi.owned=build"}

const (
	// builtByLabel says which task built an image.
	builtByLabel = "majhi.task"
	// BuildCacheCap is the most the Docker build cache may hold after an update; older layers above it are trimmed.
	BuildCacheCap = "15gb"
	stepTimeout   = 60 * time.Second
	imageFormat   = "{{.Repository}}\t{{.Tag}}\t{{.ID}}\t{{.Size}}"
	// ReleaseLabel is what the release workflow puts on every release image, with its version.
	ReleaseLabel = "majhi.release"
)

// PreviousTags are the tags `update` keeps before building, so a failed update can go back.
var PreviousTags = []string{"majhi-server:previous", "majhi-laya:previous"}

// BuildCacheAges are the ages the cache is trimmed by, oldest first. Docker 29's `--max-used-space`
// and `--keep-storage` free nothing in practice, so the cap is kept by age: drop unused cache older
// than each step until the cache is under the cap. Never an unfiltered prune.
var BuildCacheAges = []string{"168h", "72h", "48h", "24h", "12h", "6h", "3h"}

// simpleStep is a Step without the environment override.
type simpleStep func(label string, args []string, timeout time.Duration) (string, error)

func simple(step Step) simpleStep {
	return func(label string, args []string, timeout time.Duration) (string, error) {
		return step(label, args, timeout, nil)
	}
}

// ReadOpenTasks is the ids of the tasks that are not done, or nil when they are not known.
func ReadOpenTasks(majhiHome string) map[string]bool {
	data, err := os.ReadFile(filepath.Join(majhiHome, protocol.OpenTasksFile))
	if err != nil {
		return nil
	}
	var body struct {
		Tasks []string `json:"tasks"`
	}
	if json.Unmarshal(data, &body) != nil || body.Tasks == nil {
		return nil
	}
	open := make(map[string]bool, len(body.Tasks))
	for _, id := range body.Tasks {
		open[id] = true
	}
	return open
}

// ImageRow is one image row of `docker image ls`.
type ImageRow struct{ Repository, Tag, ID, Size string }

func nonEmptyLines(out string) []string {
	var lines []string
	for _, l := range strings.Split(out, "\n") {
		if l = strings.TrimSpace(l); l != "" {
			lines = append(lines, l)
		}
	}
	return lines
}

func parseImages(out string) []ImageRow {
	var rows []ImageRow
	for _, row := range nonEmptyLines(out) {
		f := strings.Split(row, "\t")
		if len(f) < 3 {
			continue
		}
		r := ImageRow{Repository: f[0], Tag: f[1], ID: f[2]}
		if len(f) > 3 {
			r.Size = f[3]
		}
		rows = append(rows, r)
	}
	return rows
}

// OwnImage is an image majhi labelled, with the task that built it.
type OwnImage struct {
	// Ref is what to remove it by: `repository:tag`, or the id when it has no tag.
	Ref string
	// BuiltBy is `majhi.task`, empty when the image has no such label.
	BuiltBy string
	Bytes   float64
}

// SelectOwnImages are the images to remove: majhi's own, built by a task that is not open. With the
// open tasks unknown (nil), none.
func SelectOwnImages(rows []OwnImage, open map[string]bool) []OwnImage {
	if open == nil {
		return nil
	}
	var out []OwnImage
	for _, r := range rows {
		if r.BuiltBy != "" && !open[r.BuiltBy] {
			out = append(out, r)
		}
	}
	return out
}

func parseOwnImages(out string) []OwnImage {
	var rows []OwnImage
	for _, row := range nonEmptyLines(out) {
		f := strings.Split(row, "\t")
		for len(f) < 4 {
			f = append(f, "")
		}
		if f[0] == "" {
			continue
		}
		ref := f[0]
		for _, tag := range strings.Split(f[3], ",") {
			if tag != "" {
				ref = tag
				break
			}
		}
		bytes, _ := strconv.ParseFloat(f[2], 64)
		rows = append(rows, OwnImage{Ref: ref, BuiltBy: f[1], Bytes: bytes})
	}
	return rows
}

// SizeBytes reads "1.2GB" or "512MB" as bytes. 0 when it cannot be read.
func SizeBytes(size string) float64 {
	text := strings.TrimSpace(size)
	cut := len(text)
	for cut > 0 && !(text[cut-1] >= '0' && text[cut-1] <= '9' || text[cut-1] == '.') {
		cut--
	}
	number, unit := text[:cut], strings.ToUpper(strings.TrimSpace(text[cut:]))
	n, err := strconv.ParseFloat(number, 64)
	if err != nil || number == "" {
		return 0
	}
	units := map[string]float64{"B": 1, "KB": 1e3, "MB": 1e6, "GB": 1e9, "TB": 1e12}
	factor, ok := units[unit]
	if !ok {
		return 0
	}
	return n * factor
}

// SizeText is bytes in plain words.
func SizeText(bytes float64) string {
	switch {
	case bytes >= 1e9:
		return fmt.Sprintf("%.1f GB", bytes/1e9)
	case bytes >= 1e6:
		return fmt.Sprintf("%d MB", int64(math.Round(bytes/1e6)))
	}
	return fmt.Sprintf("%d kB", int64(math.Round(bytes/1e3)))
}

func attempt(_ string, err error) bool { return err == nil }

// RemoveOwnLeftovers removes the images listed above and reports them in plain words, with sizes.
// Every removal is best effort: a failed one is skipped and never fails an update that already runs.
func RemoveOwnLeftovers(step simpleStep, majhiHome string, say func(string), tags []string) {
	total := 0.0
	var gone []string
	removeImage := func(ref, label string, bytes float64) {
		if !attempt(step("remove an old image", []string{"image", "rm", ref}, stepTimeout)) {
			return
		}
		total += bytes
		gone = append(gone, label)
	}
	for _, tag := range tags {
		listed, _ := step("find the previous image", []string{"image", "ls", "--format", imageFormat, tag}, stepTimeout)
		for _, row := range parseImages(listed) {
			if row.Repository+":"+row.Tag != tag {
				continue
			}
			label := tag
			if row.Size != "" {
				label = tag + " (" + row.Size + ")"
			}
			removeImage(tag, label, SizeBytes(row.Size))
			break
		}
	}

	open := ReadOpenTasks(majhiHome)
	if open == nil {
		say("Kept the preview images: the list of open tasks was not available")
	} else {
		// By label: the images majhi built, and the task that built each. No name is read as a pattern.
		out, err := step("list majhi's images", []string{"image", "ls", "-q", "--no-trunc", "--filter", "label=" + MajhiImageLabels[0]}, stepTimeout)
		var ids []string
		if err == nil {
			seen := map[string]bool{}
			for _, id := range nonEmptyLines(out) {
				if !seen[id] {
					seen[id] = true
					ids = append(ids, id)
				}
			}
		}
		inspected := ""
		if len(ids) > 0 {
			args := append([]string{"image", "inspect", "--format",
				`{{.Id}}` + "\t" + `{{index .Config.Labels "` + builtByLabel + `"}}` + "\t" + `{{.Size}}` + "\t" + `{{join .RepoTags ","}}`}, ids...)
			inspected, _ = step("read majhi's images", args, stepTimeout)
		}
		for _, image := range SelectOwnImages(parseOwnImages(inspected), open) {
			removeImage(image.Ref, image.Ref+" ("+SizeText(image.Bytes)+")", image.Bytes)
		}
	}

	// Dangling images majhi built: one pass per label, never an unfiltered prune.
	for _, label := range MajhiImageLabels {
		listed, _ := step("list dangling images", []string{"image", "ls", "--filter", "dangling=true", "--filter", "label=" + label, "--format", imageFormat}, stepTimeout)
		dangling := parseImages(listed)
		if len(dangling) == 0 {
			continue
		}
		if !attempt(step("remove dangling images", []string{"image", "prune", "-f", "--filter", "label=" + label}, stepTimeout)) {
			continue
		}
		bytes := 0.0
		for _, r := range dangling {
			bytes += SizeBytes(r.Size)
		}
		total += bytes
		noun := "images"
		if len(dangling) == 1 {
			noun = "image"
		}
		gone = append(gone, fmt.Sprintf("%d dangling %s (%s)", len(dangling), noun, SizeText(bytes)))
	}

	// The build cache is capped, not cleared: the newest layers keep updates fast, and only the oldest
	// unused ones above the cap go, by age, never an unfiltered prune (the owner's rule).
	capBytes := SizeBytes(strings.ToUpper(BuildCacheCap))
	cacheSize := func() (float64, bool) {
		out, _ := step("measure the build cache", []string{"system", "df", "--format", "{{.Type}}\t{{.Size}}"}, stepTimeout)
		for _, line := range nonEmptyLines(out) {
			if f := strings.Split(line, "\t"); len(f) > 1 && f[0] == "Build Cache" {
				return SizeBytes(f[1]), true
			}
		}
		return 0, false
	}
	if before, ok := cacheSize(); ok && before > capBytes {
		current := before
		for _, age := range BuildCacheAges {
			if current <= capBytes {
				break
			}
			attempt(step("cap the build cache", []string{"builder", "prune", "-f", "-a", "--filter", "until=" + age}, stepTimeout))
			if now, ok := cacheSize(); ok {
				current = now
			}
		}
		if current < before {
			total += before - current
			gone = append(gone, "build cache trimmed from "+SizeText(before)+" to "+SizeText(current))
		}
	}

	if len(gone) == 0 {
		say("No old majhi images to remove")
		return
	}
	say("Removed " + strings.Join(gone, ", ") + ". About " + SizeText(total) + " freed")
}

// SelectOtherReleases are the release images (`<registry>/majhi-*:<tag>`, from ghcr.io) of other
// versions than version: what runs now was built on that version's. The `majhi-*:dev` images built
// on them carry the label too, but have no registry in their name, so they are never picked.
func SelectOtherReleases(rows []ImageRow, version string) []ImageRow {
	var out []ImageRow
	for _, r := range rows {
		if strings.Contains(r.Repository, "/") && r.Tag != "<none>" && r.Tag != version && !strings.HasPrefix(r.Tag, version+"-") {
			out = append(out, r)
		}
	}
	return out
}

// RemoveOtherReleases removes the release images of the version before, after a release install
// moved to version. Best effort.
func RemoveOtherReleases(step simpleStep, version string, say func(string)) {
	listed, _ := step("list release images", []string{"image", "ls", "--filter", "label=" + ReleaseLabel, "--format", imageFormat}, stepTimeout)
	var gone []string
	for _, row := range SelectOtherReleases(parseImages(listed), version) {
		ref := row.Repository + ":" + row.Tag
		if attempt(step("remove an old release image", []string{"image", "rm", ref}, stepTimeout)) {
			gone = append(gone, ref)
		}
	}
	if len(gone) > 0 {
		say("Removed the images of the release before: " + strings.Join(gone, ", "))
	}
}
