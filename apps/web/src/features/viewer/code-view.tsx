import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import { useHighlight } from "@/features/room/highlight";
import { CopyButton } from "@/features/room/markdown";
import { fenceFor, HIGHLIGHT_LIMIT, lineNumbers } from "./model";

const noPre = { pre: ({ children }: { children?: React.ReactNode }) => <>{children}</> };

/** Source with line numbers and syntax colors. The numbers stay put while the code scrolls sideways. */
export function CodeView({ text, lang, label }: { text: string; lang: string | undefined; label: string }) {
  const plugins = useHighlight();
  const gutter = useMemo(() => lineNumbers(text), [text]);
  const colored = lang !== undefined && plugins !== undefined && text.length <= HIGHLIGHT_LIMIT;
  const fenced = useMemo(() => {
    if (!colored) return "";
    const body = text.replace(/\n$/, "");
    const fence = fenceFor(body);
    return `${fence}${lang}\n${body}\n${fence}`;
  }, [colored, text, lang]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-line-strong px-3 text-xs text-fg-faint">
        <span className="font-mono">
          {lang ?? "plain text"} · {gutter.split("\n").length} lines
          {lang !== undefined && text.length > HIGHLIGHT_LIMIT && " · colors off for a large file"}
        </span>
        <CopyButton text={text} label={`Copy ${label}`} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-sunken">
        <div className="code-lines">
          <pre aria-hidden="true" className="code-gutter">
            {gutter}
          </pre>
          <pre className="code-body">
            {colored ? (
              <ReactMarkdown rehypePlugins={plugins} components={noPre}>
                {fenced}
              </ReactMarkdown>
            ) : (
              <code>{text}</code>
            )}
          </pre>
        </div>
      </div>
    </div>
  );
}
