package platform

import (
	"crypto/sha256"
	_ "embed" // the notifier's source and icon
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"majhi/host/internal/run"
	"majhi/host/internal/sys"
)

// majhi's own notifier on macOS: a small app named majhi, with the majhi icon and its own bundle id
// (`dev.majhi.alerts`), built on the owner's Mac with `swiftc` and signed ad hoc, so macOS lists
// its notifications under "majhi" and a click opens the page. Nothing is downloaded and nothing is
// signed with a certificate. Without the Command Line Tools it is not built, and the helper falls
// back to terminal-notifier (see MacNotifier).

//go:embed assets/notifier.swift
var notifierSwift string

//go:embed assets/icon.png
var notifierIconPNG []byte

const (
	notifierBundleID = "dev.majhi.alerts"
	// NotifierOffCode is the notifier's exit code when macOS has notifications off for it. terminal-notifier uses it too.
	NotifierOffCode = 3
	// NotifierNotAskedCode is its exit code when the owner has not been asked yet. `authorize` asks.
	NotifierNotAskedCode = 5

	xcodeSelect  = "/usr/bin/xcode-select"
	swiftc       = "/usr/bin/swiftc"
	sips         = "/usr/bin/sips"
	iconutil     = "/usr/bin/iconutil"
	codesign     = "/usr/bin/codesign"
	notifierExe  = "majhi-notifier"
	buildTimeout = 180 * time.Second
	stepTimeout  = 30 * time.Second
	// buildRetry: after a failed build, the next notification tries again only after this long.
	buildRetry = 60 * time.Minute
)

// NotifierStamp names the source and icon this helper builds from, so a newer helper rebuilds an
// older app. It is the same value the TypeScript helper computed, so the app it built is kept.
func NotifierStamp() string {
	sum := sha256.New()
	sum.Write([]byte(notifierSwift))
	sum.Write([]byte(base64.StdEncoding.EncodeToString(notifierIconPNG)))
	return hex.EncodeToString(sum.Sum(nil))[:16]
}

func infoPlist(stamp string) string {
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>` + notifierBundleID + `</string>
<key>CFBundleName</key><string>majhi</string>
<key>CFBundleDisplayName</key><string>majhi</string>
<key>CFBundleExecutable</key><string>` + notifierExe + `</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>1</string>
<key>CFBundleIconFile</key><string>majhi</string>
<key>LSUIElement</key><true/>
<key>LSMinimumSystemVersion</key><string>11.0</string>
<key>MajhiBuild</key><string>` + stamp + `</string>
</dict></plist>
`
}

// notifierApp is `<MAJHI_HOME>/bin/majhi-notifier/majhi.app`.
func notifierApp(majhiHome string) string {
	return filepath.Join(majhiHome, "bin", "majhi-notifier", "majhi.app")
}

func notifierProgram(majhiHome string) string {
	return filepath.Join(notifierApp(majhiHome), "Contents", "MacOS", notifierExe)
}

// notifierIsCurrent is true when the installed app was built from this helper's source. It reads only the plist.
func notifierIsCurrent(majhiHome string) bool {
	data, err := os.ReadFile(filepath.Join(notifierApp(majhiHome), "Contents", "Info.plist"))
	return err == nil && strings.Contains(string(data), "<string>"+NotifierStamp()+"</string>")
}

type buildResult int

const (
	built buildResult = iota
	buildUnsupported
	buildFailed
)

func isFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

// iconset is the sizes an .icns holds, as the iconset's file names.
var iconset = []struct {
	name string
	px   int
}{
	{"icon_16x16", 16}, {"icon_16x16@2x", 32}, {"icon_32x32", 32}, {"icon_32x32@2x", 64},
	{"icon_128x128", 128}, {"icon_128x128@2x", 256}, {"icon_256x256", 256}, {"icon_256x256@2x", 512},
	{"icon_512x512", 512},
}

// buildNotifier builds the app in a temporary folder next to the install folder: compile, icon,
// ad-hoc signature, then a check that the signature holds and the program starts and reads its
// permission. Only a verified app is renamed into place, so a half-done build is never used.
func buildNotifier(deps sys.Deps) buildResult {
	plain := map[string]string{"PATH": "/usr/bin:/bin"}
	select1 := deps.Run(xcodeSelect, []string{"-p"}, run.Options{Env: plain, Timeout: stepTimeout})
	if select1.Code != 0 || !deps.Exists(swiftc) {
		deps.Log("notify: the Command Line Tools are not installed, so majhi's own notifier is not built")
		return buildUnsupported
	}
	bin := filepath.Join(deps.MajhiHome, "bin")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		deps.Log("notify: could not build majhi's notifier: " + err.Error())
		return buildFailed
	}
	work, err := os.MkdirTemp(bin, ".majhi-notifier-")
	if err != nil {
		deps.Log("notify: could not build majhi's notifier: " + err.Error())
		return buildFailed
	}
	defer os.RemoveAll(work)
	fail := func(err error) buildResult {
		deps.Log("notify: could not build majhi's notifier: " + err.Error())
		return buildFailed
	}
	app := filepath.Join(work, "majhi.app")
	contents := filepath.Join(app, "Contents")
	program := filepath.Join(contents, "MacOS", notifierExe)
	resources := filepath.Join(contents, "Resources")
	for _, dir := range []string{filepath.Join(contents, "MacOS"), resources} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return fail(err)
		}
	}
	env := map[string]string{"PATH": "/usr/bin:/bin", "HOME": deps.Home, "TMPDIR": work}
	step := func(file string, args []string, timeout time.Duration) run.Result {
		return deps.Run(file, args, run.Options{Env: env, Timeout: timeout})
	}

	source := filepath.Join(work, "notifier.swift")
	if err := os.WriteFile(source, []byte(notifierSwift), 0o644); err != nil {
		return fail(err)
	}
	if err := os.WriteFile(filepath.Join(contents, "Info.plist"), []byte(infoPlist(NotifierStamp())), 0o644); err != nil {
		return fail(err)
	}
	compiled := step(swiftc, []string{"-O", "-swift-version", "5", "-module-cache-path", filepath.Join(work, "modules"), source, "-o", program}, buildTimeout)
	if compiled.Code != 0 || !isFile(program) {
		deps.Log("notify: swiftc did not build the notifier: " + firstChars(strings.TrimSpace(compiled.Stderr), 300))
		return buildFailed
	}

	// The icon is a nicety: without it the app still works, with the generic one.
	iconDir := filepath.Join(work, "majhi.iconset")
	if err := os.MkdirAll(iconDir, 0o755); err != nil {
		return fail(err)
	}
	png := filepath.Join(work, "majhi-512.png")
	if err := os.WriteFile(png, notifierIconPNG, 0o644); err != nil {
		return fail(err)
	}
	iconOK := true
	for _, size := range iconset {
		sized := step(sips, []string{"-z", fmt.Sprint(size.px), fmt.Sprint(size.px), png, "--out", filepath.Join(iconDir, size.name+".png")}, stepTimeout)
		if sized.Code != 0 {
			iconOK = false
		}
	}
	icnsOK := false
	if iconOK {
		icnsOK = step(iconutil, []string{"-c", "icns", iconDir, "-o", filepath.Join(resources, "majhi.icns")}, stepTimeout).Code == 0
	}
	if !icnsOK {
		deps.Log("notify: majhi's notifier has no icon, the icon tools did not run")
	}

	signed := step(codesign, []string{"--force", "--sign", "-", app}, stepTimeout)
	checked := step(codesign, []string{"--verify", "--strict", app}, stepTimeout)
	if signed.Code != 0 || checked.Code != 0 {
		deps.Log("notify: the notifier's ad-hoc signature did not verify")
		return buildFailed
	}
	// 0 allowed, 5 not asked yet, 3 off for it: all three mean it built and runs. Anything else does not.
	status := step(program, []string{"status"}, stepTimeout)
	if status.Code != 0 && status.Code != NotifierNotAskedCode && status.Code != NotifierOffCode {
		deps.Log(fmt.Sprintf("notify: the built notifier did not start (exit %d)", status.Code))
		return buildFailed
	}

	target := filepath.Join(bin, "majhi-notifier")
	if err := os.RemoveAll(target); err != nil {
		return fail(err)
	}
	if err := os.MkdirAll(target, 0o755); err != nil {
		return fail(err)
	}
	if err := os.Rename(app, notifierApp(deps.MajhiHome)); err != nil {
		return fail(err)
	}
	deps.Log("notify: built majhi's notifier in " + notifierApp(deps.MajhiHome))
	return built
}

func firstChars(text string, n int) string {
	runes := []rune(text)
	if len(runes) > n {
		return string(runes[:n])
	}
	return text
}
