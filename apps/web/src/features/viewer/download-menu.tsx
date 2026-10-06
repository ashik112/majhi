import { type DownloadFormat, downloadName, downloadUrl, type ViewerKind } from "@majhi/shared";
import { ChevronDown, Download, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Menu, type MenuItem } from "@/components/ui/menu";
import { useToast } from "@/components/ui/toast";

type Export = Exclude<DownloadFormat, "raw">;

const EXPORTS: readonly { format: Export; label: string; busy: string }[] = [
  { format: "html", label: "Web page (.html)", busy: "Making page" },
  { format: "pdf", label: "PDF (.pdf)", busy: "Making PDF" },
  { format: "docx", label: "Word (.docx)", busy: "Making Word file" },
];

/** Hands a URL or blob to the browser's own download, under `name`. */
function save(href: string, name: string) {
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
}

async function failure(res: Response): Promise<string> {
  const body: unknown = await res.json().catch(() => undefined);
  const error = typeof body === "object" && body !== null && "error" in body ? body.error : undefined;
  return typeof error === "string" ? error : `The server answered ${res.status}.`;
}

/**
 * The viewer's Download button. Any file downloads as it is, streamed by the browser itself. A
 * markdown file also exports as a page, a PDF or a Word file, made on the server from the same render
 * (`?download=<format>`); a spinner shows while it is made, and the tab stays free meanwhile.
 */
export function DownloadMenu({ url, path, kind }: { url: string; path: string; kind: ViewerKind }) {
  const toast = useToast();
  const [busy, setBusy] = useState<Export | undefined>();
  const abort = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => abort.current?.abort(), []);

  const raw = () => save(downloadUrl(url, "raw"), downloadName(path, "raw"));

  async function exportAs(format: Export) {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setBusy(format);
    try {
      const res = await fetch(downloadUrl(url, format), { cache: "no-store", signal: controller.signal });
      if (!res.ok) throw new Error(await failure(res));
      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      save(href, downloadName(path, format));
      // The browser has taken the file once the click is handled; free the memory after.
      setTimeout(() => URL.revokeObjectURL(href), 10_000);
    } catch (err) {
      if (controller.signal.aborted) return;
      toast(`Could not download as ${format}`, {
        detail: err instanceof Error ? err.message : String(err),
        tone: "error",
      });
    } finally {
      if (abort.current === controller) {
        abort.current = undefined;
        setBusy(undefined);
      }
    }
  }

  if (kind !== "markdown") {
    return (
      <Button size="sm" variant="secondary" onClick={raw}>
        <Download aria-hidden="true" />
        Download
      </Button>
    );
  }

  const items: MenuItem[] = [
    { label: "Markdown (.md)", onSelect: raw },
    ...EXPORTS.map((e) => ({ label: e.label, onSelect: () => void exportAs(e.format) })),
  ];
  const working = EXPORTS.find((e) => e.format === busy);
  return (
    <Menu
      label="Download as"
      items={items}
      trigger={(props) => (
        <Button
          size="sm"
          variant="secondary"
          disabled={working !== undefined}
          aria-busy={working !== undefined}
          {...props}
        >
          {working ? (
            <LoaderCircle aria-hidden="true" className="animate-spin" />
          ) : (
            <Download aria-hidden="true" />
          )}
          {working ? working.busy : "Download"}
          {!working && <ChevronDown aria-hidden="true" className="-mr-0.5" />}
        </Button>
      )}
    />
  );
}
