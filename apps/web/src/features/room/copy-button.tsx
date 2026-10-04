import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1500);
    return () => clearTimeout(t);
  }, [done]);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
    } catch {
      // Clipboard access can be blocked; the text is still selectable.
    }
  }
  return (
    <button
      type="button"
      aria-label={label}
      onClick={copy}
      className="flex h-5 cursor-pointer items-center gap-1 rounded-xs px-1 text-xs text-fg-faint hover:bg-raised hover:text-fg"
    >
      {done ? (
        <Check aria-hidden="true" className="size-3" />
      ) : (
        <Copy aria-hidden="true" className="size-3" />
      )}
      {done ? "Copied" : "Copy"}
    </button>
  );
}
