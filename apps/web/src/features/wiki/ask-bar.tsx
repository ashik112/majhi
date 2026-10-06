import type { WikiAskOutput, WikiPageId, WikiPageSummary } from "@majhi/shared";
import { Send, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { ApiRequestError } from "@/lib/api";
import { useWikiAsk } from "@/lib/wiki-queries";
import { COPY } from "./copy";
import type { LoadedPage } from "./page-view";
import { type OpenSource, SourceChip, Text } from "./parts";

/** Questions the pages themselves suggest, with no model: one for the sign-in component and one for each flow. */
export function suggestions(all: readonly LoadedPage[]): string[] {
  const out: string[] = [];
  const overview = all.find((l) => l.page.kind === "overview")?.page;
  const auth = overview?.roles.find((r) => r.role === "auth" && r.page !== undefined);
  const authPage = all.find((l) => l.summary.id === auth?.page);
  if (authPage !== undefined) out.push(`Where is ${authPage.summary.title.toLowerCase()} handled?`);
  for (const l of all) {
    if (l.page.kind === "flow" && out.length < 3) out.push(`How does ${l.summary.title.toLowerCase()} work?`);
  }
  return out;
}

type Asked = { question: string; answer: WikiAskOutput } | { question: string; error: string };

/**
 * The Ask box, pinned under a page: one input, one button. The answer shows as a card above the input with the
 * question, the answer's text and the files and pages it came from. While the input is focused the pages offer
 * a few questions of their own.
 */
export function AskBar({
  org,
  project,
  all,
  summaries,
  onOpen,
  onGo,
}: {
  org: string;
  project: string | undefined;
  all: readonly LoadedPage[];
  summaries: readonly WikiPageSummary[];
  onOpen: OpenSource;
  /** Open a page of a project, or of the workspace when `project` is undefined. */
  onGo: (project: string | undefined, id: WikiPageId) => void;
}) {
  const ask = useWikiAsk();
  const [text, setText] = useState("");
  const [focus, setFocus] = useState(false);
  const [asked, setAsked] = useState<Asked>();
  const scopeKey = `${org}:${project ?? ""}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: another scope has other answers.
  useEffect(() => {
    setAsked(undefined);
    setText("");
  }, [scopeKey]);
  const hints = useMemo(() => suggestions(all), [all]);

  const send = (question: string) => {
    const q = question.trim();
    if (q === "" || ask.isPending) return;
    setText(q);
    ask.mutate(
      { org, ...(project === undefined ? {} : { project }), question: q },
      {
        onSuccess: (answer) => setAsked({ question: q, answer }),
        onError: (e) =>
          setAsked({
            question: q,
            error: e instanceof ApiRequestError && e.status === 404 ? COPY.ask.notBuilt : e.message,
          }),
      },
    );
  };
  const placeholder = project === undefined ? COPY.ask.workspacePlaceholder : COPY.ask.projectPlaceholder;
  const titleOf = (id: WikiPageId) => summaries.find((s) => s.id === id)?.title ?? id;
  return (
    <div className="flex flex-col gap-2" data-ask="">
      {(asked !== undefined || ask.isPending) && (
        <div
          className="flex max-h-[170px] flex-col gap-2 overflow-y-auto overscroll-contain rounded-[10px] border border-line-strong bg-raised px-3 py-2.5"
          aria-live="polite"
        >
          <p className="m-0 text-sm text-fg-muted">{ask.isPending ? text : asked?.question}</p>
          {ask.isPending ? (
            <p className="m-0 text-base text-fg-soft">{COPY.ask.asking}</p>
          ) : asked !== undefined && "error" in asked ? (
            <p className="m-0 text-base text-fg-soft">{asked.error}</p>
          ) : (
            asked !== undefined && (
              <>
                <Text className="text-fg">{asked.answer.answer}</Text>
                {(asked.answer.sources.length > 0 || asked.answer.pages.length > 0) && (
                  <div className="flex flex-wrap gap-1.5">
                    {asked.answer.sources.map((s) => (
                      <SourceChip
                        key={`${s.repo}:${s.path}:${s.lines[0]}`}
                        source={s}
                        moved={false}
                        onOpen={onOpen}
                      />
                    ))}
                    {asked.answer.pages.map((p) => (
                      <button
                        key={`${p.project ?? ""}:${p.id}`}
                        type="button"
                        data-ask-page={p.id}
                        title={p.project === undefined ? undefined : p.project}
                        onClick={() => onGo(p.project, p.id)}
                        className="inline-flex h-6 cursor-pointer items-center rounded-sm border border-line-strong px-2 text-xs text-fg-soft transition-colors duration-150 hover:border-line-hover hover:text-fg"
                      >
                        {titleOf(p.id)}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )
          )}
        </div>
      )}
      {focus && hints.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {hints.map((h) => (
            <button
              key={h}
              type="button"
              // The input must keep focus, so the chips do not show and hide under the click.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => send(h)}
              className="h-6 cursor-pointer rounded-full border border-line-strong px-2.5 text-xs text-fg-muted transition-colors duration-150 hover:border-line-hover hover:text-fg"
            >
              {h}
            </button>
          ))}
        </div>
      )}
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          send(text);
        }}
      >
        <label className="flex h-[34px] min-w-0 flex-1 items-center gap-2 rounded-md border border-line-control bg-field px-2.5 text-fg-faint focus-within:border-accent">
          <Sparkles aria-hidden="true" className="size-3.5 shrink-0" />
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onFocus={() => setFocus(true)}
            onBlur={() => setFocus(false)}
            placeholder={placeholder}
            aria-label={placeholder}
            autoComplete="off"
            className="min-w-0 flex-1 bg-transparent text-base text-fg outline-none placeholder:text-fg-faint"
          />
        </label>
        <Button type="submit" disabled={ask.isPending || text.trim() === ""}>
          <Send aria-hidden="true" />
          {COPY.ask.button}
        </Button>
      </form>
    </div>
  );
}
