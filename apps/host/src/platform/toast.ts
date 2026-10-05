/**
 * A Windows toast from WSL2 through `powershell.exe` (decision 8). It shows under Windows
 * PowerShell's own app id, so nothing has to be registered. A toast with a URL opens it in the
 * default browser when clicked (`activationType="protocol"`). The script goes as `-EncodedCommand`,
 * and the title, message and URL sit XML-escaped inside one single-quoted PowerShell string, so
 * nothing in them can run.
 */
import type { RunFn } from "../ssh.ts";
import type { Notifier, NotifyRequest } from "./types.ts";

/** Windows PowerShell's app id, which may show toasts without registering anything. */
export const POWERSHELL_APP_ID =
  "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";
const TOAST_TIMEOUT_MS = 20_000;
const NOT_SHOWN = "Windows did not show the notification. Check Settings, System, Notifications in Windows.";

/**
 * Text for XML content and attributes, from `plainLine` or `clickUrl`, so it holds no control
 * characters. The quotes that end a single-quoted PowerShell string (`'` and U+2018 to U+201B)
 * become character references too, so the XML can sit inside one.
 */
function xmlText(text: string): string {
  return text.replace(/[&<>"'‘-‛]/g, (ch) => `&#x${(ch.codePointAt(0) ?? 0).toString(16)};`);
}

/** The toast. Without a URL a click only dismisses it (`background` with no task to run). */
export function toastXml(request: NotifyRequest): string {
  const activation =
    request.url === undefined
      ? 'activationType="background"'
      : `activationType="protocol" launch="${xmlText(request.url)}"`;
  const audio = request.sound ? "" : '<audio silent="true"/>';
  return (
    `<toast ${activation}><visual><binding template="ToastGeneric">` +
    `<text>${xmlText(request.title)}</text><text>${xmlText(request.message)}</text>` +
    `</binding></visual>${audio}</toast>`
  );
}

export function toastScript(request: NotifyRequest): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
    "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null",
    "$xml = New-Object Windows.Data.Xml.Dom.XmlDocument",
    `$xml.LoadXml('${toastXml(request)}')`,
    "$toast = New-Object Windows.UI.Notifications.ToastNotification $xml",
    `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${POWERSHELL_APP_ID}').Show($toast)`,
  ].join("\n");
}

/** `powershell.exe` arguments that run `script` with no profile and no prompt. */
export function powershellArgs(script: string): string[] {
  return [
    "-NoProfile",
    "-NonInteractive",
    "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64"),
  ];
}

export interface ToastDeps {
  run: RunFn;
  /** `powershell.exe`, or undefined when Windows cannot be reached. */
  powershell: () => Promise<string | undefined>;
  /** `desktopEnv()`: interop needs WSL_INTEROP. */
  env: () => Promise<Record<string, string>>;
}

export function toastNotifier(deps: ToastDeps): Notifier {
  return {
    async show(request) {
      const powershell = await deps.powershell();
      if (powershell !== undefined) {
        const result = await deps.run(powershell, powershellArgs(toastScript(request)), {
          env: await deps.env(),
          timeoutMs: TOAST_TIMEOUT_MS,
        });
        if (result.code === 0) return { kind: "shown", clickable: request.url !== undefined };
      }
      throw new Error(NOT_SHOWN);
    },
  };
}
