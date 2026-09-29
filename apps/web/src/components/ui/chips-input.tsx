import { X } from "lucide-react";
import { type KeyboardEvent, useState } from "react";

/** Splits typed text into lowercase words and adds the ones not present yet. */
export function addWords(list: readonly string[], text: string): string[] {
  const out = [...list];
  for (const word of text.toLowerCase().split(/[\s,]+/)) {
    if (word !== "" && !out.includes(word)) out.push(word);
  }
  return out;
}

/** Words as chips. Enter, comma or space adds one, Backspace on an empty field removes the last. */
export function ChipsInput({
  id,
  value,
  onChange,
  label,
  placeholder,
  "aria-describedby": describedBy,
}: {
  id?: string;
  value: readonly string[];
  onChange: (next: string[]) => void;
  label: string;
  placeholder?: string;
  "aria-describedby"?: string | undefined;
}) {
  const [draft, setDraft] = useState("");

  function commit() {
    if (draft.trim() === "") return;
    onChange(addWords(value, draft));
    setDraft("");
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || event.key === "," || event.key === " ") {
      if (draft.trim() === "" && event.key !== "Enter") return;
      event.preventDefault();
      commit();
    } else if (event.key === "Backspace" && draft === "" && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  }

  return (
    <div className="flex min-h-[34px] flex-wrap items-center gap-1.5 rounded-md border border-line-control bg-field px-2 py-1 focus-within:border-blue">
      {value.map((word) => (
        <span
          key={word}
          className="flex h-6 items-center gap-1 rounded-sm border border-line-strong bg-card pr-0.5 pl-2 font-mono text-xs text-fg-soft"
        >
          {word}
          <button
            type="button"
            aria-label={`Remove alias ${word}`}
            onClick={() => onChange(value.filter((w) => w !== word))}
            className="flex size-5 items-center justify-center rounded-xs hover:bg-raised"
          >
            <X aria-hidden="true" className="size-3" />
          </button>
        </span>
      ))}
      <input
        id={id}
        aria-label={label}
        aria-describedby={describedBy}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={commit}
        placeholder={value.length === 0 ? placeholder : undefined}
        spellCheck={false}
        autoComplete="off"
        className="h-6 min-w-24 flex-1 bg-transparent text-base text-fg outline-none"
      />
    </div>
  );
}
