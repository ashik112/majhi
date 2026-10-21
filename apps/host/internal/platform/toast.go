package platform

import (
	"encoding/base64"
	"fmt"
	"strings"
	"time"
	"unicode/utf16"

	"majhi/host/internal/notify"
	"majhi/host/internal/run"
)

// A Windows toast from WSL2 through `powershell.exe` (decision 8). It shows under Windows
// PowerShell's own app id, so nothing has to be registered. A toast with a URL opens it in the
// default browser when clicked (`activationType="protocol"`). The script goes as `-EncodedCommand`,
// and the title, message and URL sit XML-escaped inside one single-quoted PowerShell string, so
// nothing in them can run.

// PowerShellAppID is Windows PowerShell's app id, which may show toasts without registering anything.
const PowerShellAppID = `{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe`

const (
	toastTimeout  = 20 * time.Second
	toastNotShown = "Windows did not show the notification. Check Settings, System, Notifications in Windows."
)

// xmlText is text for XML content and attributes, from PlainLine or ClickURL, so it holds no control
// characters. The quotes that end a single-quoted PowerShell string (`'` and U+2018 to U+201B)
// become character references too, so the XML can sit inside one.
func xmlText(text string) string {
	var out strings.Builder
	for _, r := range text {
		switch {
		case r == '&' || r == '<' || r == '>' || r == '"' || r == '\'' || (r >= 0x2018 && r <= 0x201B):
			fmt.Fprintf(&out, "&#x%x;", r)
		default:
			out.WriteRune(r)
		}
	}
	return out.String()
}

// ToastXML is the toast. Without a URL a click only dismisses it (`background` with no task to run).
func ToastXML(request notify.Request) string {
	activation := `activationType="background"`
	if request.URL != "" {
		activation = fmt.Sprintf(`activationType="protocol" launch="%s"`, xmlText(request.URL))
	}
	audio := ""
	if !request.Sound {
		audio = `<audio silent="true"/>`
	}
	return fmt.Sprintf(`<toast %s><visual><binding template="ToastGeneric"><text>%s</text><text>%s</text></binding></visual>%s</toast>`,
		activation, xmlText(request.Title), xmlText(request.Message), audio)
}

// ToastScript is the PowerShell that shows the toast.
func ToastScript(request notify.Request) string {
	return strings.Join([]string{
		"$ErrorActionPreference = 'Stop'",
		"[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
		"[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null",
		"$xml = New-Object Windows.Data.Xml.Dom.XmlDocument",
		fmt.Sprintf("$xml.LoadXml('%s')", ToastXML(request)),
		"$toast = New-Object Windows.UI.Notifications.ToastNotification $xml",
		fmt.Sprintf("[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('%s').Show($toast)", PowerShellAppID),
	}, "\n")
}

// PowerShellArgs are the `powershell.exe` arguments that run script with no profile and no prompt.
func PowerShellArgs(script string) []string {
	units := utf16.Encode([]rune(script))
	raw := make([]byte, 0, len(units)*2)
	for _, u := range units {
		raw = append(raw, byte(u), byte(u>>8))
	}
	return []string{"-NoProfile", "-NonInteractive", "-EncodedCommand", base64.StdEncoding.EncodeToString(raw)}
}

type toastNotifier struct {
	run run.Func
	// powershell is `powershell.exe`, or "" when Windows cannot be reached.
	powershell func() string
	env        func() map[string]string
}

func (t toastNotifier) Show(request notify.Request) (notify.Outcome, error) {
	if powershell := t.powershell(); powershell != "" {
		result := t.run(powershell, PowerShellArgs(ToastScript(request)), run.Options{Env: t.env(), Timeout: toastTimeout})
		if result.Code == 0 {
			return notify.Outcome{Kind: notify.Shown, Clickable: request.URL != ""}, nil
		}
	}
	return notify.Outcome{}, notifyError(toastNotShown)
}
