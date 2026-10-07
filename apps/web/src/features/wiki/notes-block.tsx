import type { WikiPage } from "@majhi/shared";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { describeError } from "@/lib/errors";
import { useWikiUpdate } from "@/lib/wiki-queries";
import { COPY } from "./copy";
import { Block, Text } from "./parts";

/**
 * The owner's notes on a page: corrections that survive every rewrite. Adding or dropping one rewrites the page
 * (`wiki.update` with `note` or `dropNote`), so the button says so.
 */
export function NotesBlock({
  org,
  project,
  page,
  notes,
}: {
  org: string;
  project: string;
  page: WikiPage;
  notes: readonly string[];
}) {
  const update = useWikiUpdate();
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState("");
  const send = (change: { note: string } | { dropNote: string }) =>
    update.mutate(
      { org, project, page: page.id, ...change },
      {
        onSuccess: () => {
          setAdding(false);
          setText("");
        },
      },
    );
  return (
    <Block title={COPY.notes.title} note={notes.length > 0 ? notes.length : undefined}>
      {notes.length > 0 && (
        <ul className="m-0 flex list-none flex-col p-0">
          {notes.map((n) => (
            <li
              key={n}
              data-note=""
              className="flex min-w-0 items-start gap-3 border-t border-line py-2 first:border-t-0 first:pt-0"
            >
              <Text className="flex-1">{n}</Text>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-1.5 text-xs"
                disabled={update.isPending}
                onClick={() => send({ dropNote: n })}
              >
                {COPY.notes.drop}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {adding ? (
        <form
          className="flex min-w-0 flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim() !== "") send({ note: text.trim() });
          }}
        >
          <Input
            autoFocus
            value={text}
            maxLength={500}
            onChange={(e) => setText(e.target.value)}
            placeholder={COPY.notes.placeholder}
            aria-label={COPY.notes.placeholder}
          />
          <div className="flex items-center gap-2">
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={update.isPending || text.trim() === ""}
            >
              {COPY.notes.save}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(false)}>
              {COPY.notes.cancel}
            </Button>
          </div>
        </form>
      ) : (
        <div>
          <Button size="sm" onClick={() => setAdding(true)}>
            {COPY.notes.add}
          </Button>
        </div>
      )}
      {update.isError && <p className="m-0 text-sm text-red">{describeError(update.error)}</p>}
    </Block>
  );
}
