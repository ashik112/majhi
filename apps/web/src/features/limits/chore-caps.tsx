import {
  type AutonomyStatus,
  type CaptainChore,
  CHORE_LABEL,
  type ChoreCaps,
  DAILY_CHORE_CAPS,
} from "@majhi/shared";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useAutonomyCommand } from "@/lib/autonomy-queries";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";

type Count = "actions" | "runs";
/** One field: "" is majhi's default, "none" is no cap, else a number as typed. */
type Draft = Partial<Record<CaptainChore, Partial<Record<Count, string>>>>;

const CHORES = Object.keys(DAILY_CHORE_CAPS) as CaptainChore[];
const COUNT_WORD: Record<Count, string> = { actions: "a day", runs: "runs a day" };

function draftOf(caps: ChoreCaps | undefined): Draft {
  const out: Draft = {};
  for (const [chore, cap] of Object.entries(caps ?? {}) as [CaptainChore, ChoreCaps[CaptainChore]][]) {
    const row: Partial<Record<Count, string>> = {};
    for (const key of ["actions", "runs"] as const) {
      const v = cap?.[key];
      if (v === null) row[key] = "none";
      else if (v !== undefined) row[key] = String(v);
    }
    out[chore] = row;
  }
  return out;
}

/** The draft as settings, or the first field that is not a cap. */
function capsOf(draft: Draft): { caps: ChoreCaps | null } | { problem: string } {
  const out: ChoreCaps = {};
  for (const [chore, row] of Object.entries(draft) as [CaptainChore, Partial<Record<Count, string>>][]) {
    const cap: { actions?: number | null; runs?: number | null } = {};
    for (const key of ["actions", "runs"] as const) {
      const text = (row[key] ?? "").trim();
      if (text === "") continue;
      if (text === "none") {
        cap[key] = null;
        continue;
      }
      const n = Number(text);
      if (!Number.isInteger(n) || n < 1) {
        return { problem: `${CHORE_LABEL[chore]}: a cap is a whole number of 1 or more, or No cap.` };
      }
      cap[key] = n;
    }
    if (Object.keys(cap).length > 0) out[chore] = cap;
  }
  return { caps: Object.keys(out).length === 0 ? null : out };
}

/** What majhi uses when the owner set nothing: ship has none where the captain decides merges. */
function defaultOf(chore: CaptainChore, key: Count, mergeDecides: boolean): number | undefined {
  if (chore === "ship" && mergeDecides) return undefined;
  return DAILY_CHORE_CAPS[chore][key];
}

/**
 * How much each captain chore may do per day in one workspace. Empty keeps majhi's default, a number
 * replaces it, and No cap removes it. The money budgets above still hold everything.
 */
export function ChoreCapsCard({
  status,
  workspaces,
}: {
  status: AutonomyStatus;
  workspaces: readonly { id: string; name: string }[];
}) {
  const [open, setOpen] = useState<string>();
  return (
    <Card aria-label="Chore limits per day">
      <h2 className="text-base font-semibold text-fg">Chore limits per day</h2>
      <p className="text-sm text-fg-muted text-pretty">
        How much each chore may do per day in a workspace before it asks you. Empty keeps the default. No cap
        removes it; the budgets above still hold.
      </p>
      <ul className="flex flex-col">
        {workspaces.map((w) => (
          <WorkspaceCaps
            key={w.id}
            id={w.id}
            name={w.name}
            status={status}
            open={open === w.id}
            onToggle={() => setOpen(open === w.id ? undefined : w.id)}
          />
        ))}
      </ul>
    </Card>
  );
}

function WorkspaceCaps({
  id,
  name,
  status,
  open,
  onToggle,
}: {
  id: string;
  name: string;
  status: AutonomyStatus;
  open: boolean;
  onToggle: () => void;
}) {
  const rules = status.settings.orgs[id];
  const mergeDecides = rules?.authority?.merge === "decide";
  const base = draftOf(rules?.chores);
  const [draft, setDraft] = useState<Draft>();
  const [problem, setProblem] = useState<string>();
  const save = useAutonomyCommand("autonomy.configure");
  const form = draft ?? base;
  const dirty = draft !== undefined && JSON.stringify(draft) !== JSON.stringify(base);
  const set = Object.keys(base).length;

  const edit = (chore: CaptainChore, key: Count, value: string) => {
    setProblem(undefined);
    setDraft({ ...form, [chore]: { ...form[chore], [key]: value } });
  };
  const submit = () => {
    const out = capsOf(form);
    if ("problem" in out) return setProblem(out.problem);
    save.mutate(
      {
        input: { orgs: { [id]: { chores: out.caps } } },
        reason: `Owner changed the chore limits per day in ${name}`,
      },
      { onSuccess: () => setDraft(undefined) },
    );
  };

  return (
    <li className="flex min-w-0 flex-col gap-2 border-t border-line py-2.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex min-h-7 w-full cursor-pointer items-center gap-3 text-left"
      >
        <span className="min-w-0 flex-1 truncate text-base text-fg" title={name}>
          {name}
        </span>
        <span className="shrink-0 text-sm text-fg-faint">
          {set === 0 ? "Defaults" : `${set} ${set === 1 ? "chore" : "chores"} changed`}
          {mergeDecides && set === 0 ? ", ships not capped" : ""}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn("size-4 shrink-0 text-fg-muted transition-transform", open && "rotate-180")}
        />
      </button>
      {open && (
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 text-sm">
            {CHORES.flatMap((chore) =>
              (["actions", "runs"] as const)
                .filter((key) => DAILY_CHORE_CAPS[chore][key] !== undefined)
                .map((key) => {
                  const value = form[chore]?.[key] ?? "";
                  const fallback = defaultOf(chore, key, mergeDecides);
                  const none = value === "none";
                  const label = `${CHORE_LABEL[chore]}, ${COUNT_WORD[key]}`;
                  return [
                    <span key={`${chore}-${key}-l`} className="min-w-0 truncate text-fg-soft" title={label}>
                      {label}
                    </span>,
                    <span key={`${chore}-${key}-f`} className="flex shrink-0 items-center gap-1.5">
                      <Input
                        aria-label={label}
                        inputMode="numeric"
                        disabled={none}
                        placeholder={fallback === undefined ? "no cap" : String(fallback)}
                        value={none ? "" : value}
                        onChange={(e) => edit(chore, key, e.target.value)}
                        className="tnum h-8 w-[76px] px-2 font-mono text-sm"
                      />
                      <Button
                        size="sm"
                        variant={none ? "primary" : "ghost"}
                        aria-pressed={none}
                        onClick={() => edit(chore, key, none ? "" : "none")}
                      >
                        No cap
                      </Button>
                    </span>,
                  ];
                }),
            )}
          </div>
          {(problem ?? save.error) && (
            <p role="alert" className="text-sm text-red">
              {problem ?? `Could not save: ${describeError(save.error)}`}
            </p>
          )}
          {(dirty || save.isPending) && (
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" disabled={save.isPending} onClick={() => setDraft(undefined)}>
                Cancel
              </Button>
              <Button size="sm" variant="primary" disabled={save.isPending} onClick={submit}>
                {save.isPending ? "Saving" : "Save"}
              </Button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}
