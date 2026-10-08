import { type PlaybookView, PRIVATE } from "@majhi/shared";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { ListChecks, Search, Target } from "lucide-react";
import { useMemo, useState } from "react";
import { Problem } from "@/components/problem";
import { Button } from "@/components/ui/button";
import { ChoiceChip } from "@/components/ui/choice-chip";
import { Input } from "@/components/ui/input";
import { ListDetail, ROW, ROW_SELECTED } from "@/components/ui/list-detail";
import { PageHeader } from "@/components/ui/page-header";
import { Select } from "@/components/ui/select";
import { Sheet } from "@/components/ui/sheet";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { describeSpec } from "@/features/actions/model";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { GLASS } from "@/lib/glass";
import { useOrgFilter } from "@/lib/org-filter";
import { usePlaybooks, useUpdatePlaybook } from "@/lib/playbook-queries";
import { useOrgs } from "@/lib/studio-queries";
import { useMedia } from "@/lib/use-media";
import { useNow } from "@/lib/use-now";
import type { AppSearch } from "@/router";
import { AddPlaybook } from "./add-playbook";
import { PlaybookDetail } from "./detail";
import { GoalsSection } from "./goals";
import { cadenceWords, KIND_LABEL, KINDS, kindOf, shortWhen } from "./model";

const CHIP = "min-h-7 px-2.5 text-xs";
const GRID = "grid grid-cols-[30px_minmax(0,1fr)_96px_minmax(0,1.1fr)] items-center gap-2.5";

type Status = "all" | "on" | "off" | "look";

/** The last result of a row in plain words, and whether it is worth a look. */
function resultOf(v: PlaybookView, now: number): { text: string; look: boolean } {
  if (!v.enabled) {
    return { text: v.playbook.needs !== undefined ? v.playbook.needs.toLowerCase() : "off", look: false };
  }
  if (v.result !== undefined) {
    const when = v.lastRun === undefined ? "" : `${shortWhen(v.lastRun, now)} `;
    return { text: `${when}${v.result}`, look: v.needsLook };
  }
  if (v.held !== undefined)
    return { text: `paused: ${v.held.charAt(0).toLowerCase()}${v.held.slice(1)}`, look: false };
  return { text: "not run yet", look: false };
}

function Row({
  view,
  selected,
  now,
  onSelect,
}: {
  view: PlaybookView;
  selected: boolean;
  now: number;
  onSelect: () => void;
}) {
  const toast = useToast();
  const update = useUpdatePlaybook();
  const locked = view.playbook.needs !== undefined;
  const result = resultOf(view, now);
  return (
    <li
      className={cn(
        GRID,
        "h-10 rounded-lg border-b border-line px-2 hover:bg-raised",
        selected && "bg-accent-wash",
      )}
    >
      <Switch
        hideLabel
        label={`${view.playbook.name} on`}
        checked={view.enabled}
        disabled={update.isPending || locked}
        title={locked ? view.playbook.needs : view.playbook.turnOn}
        onChange={(enabled) =>
          update.mutate(
            { org: view.org, id: view.playbook.id, enabled },
            { onError: (e) => toast("Could not change it", { detail: describeError(e), tone: "error" }) },
          )
        }
      />
      <button
        type="button"
        data-playbook={view.playbook.id}
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
        className={cn(
          ROW,
          "col-span-3 grid h-10 min-w-0 grid-cols-subgrid items-center bg-transparent",
          selected && ROW_SELECTED,
          "shadow-none",
        )}
      >
        <span className={cn("min-w-0 truncate text-base", view.enabled ? "text-fg" : "text-fg-muted")}>
          {view.playbook.name}
        </span>
        <span className="truncate font-mono text-xs text-fg-faint">
          {view.clock === undefined
            ? cadenceWords(view.cadence)
            : describeSpec(view.clock.when).toLowerCase()}
        </span>
        <span
          className={cn("min-w-0 truncate text-xs", result.look ? "text-accent-text" : "text-fg-faint")}
          title={result.text}
        >
          {result.text}
        </span>
      </button>
    </li>
  );
}

/**
 * The Playbooks page (`/playbooks`, SPEC 5.18): the captain's standing work as one compact list with
 * a switch, when it runs and what its last run did; the selected one in full on the right. A playbook
 * can be added from a sentence. Below 1000px the pane is the page and the list its back view.
 */
export function PlaybooksView() {
  const orgs = useOrgs().data ?? [];
  const { org: filter, setOrg } = useOrgFilter();
  const workspaces = useMemo(
    () => [{ id: PRIVATE, name: "Private" }, ...orgs.filter((o) => o.id !== PRIVATE)],
    [orgs],
  );
  // With every workspace picked, open on the first client workspace: that is where the work and the ships are.
  const org = filter ?? workspaces[1]?.id ?? PRIVATE;
  const query = usePlaybooks(org);
  const now = useNow(30_000);
  const narrow = useMedia("(max-width: 999px)");
  const search: AppSearch = useSearch({ strict: false });
  const navigate = useNavigate();
  const [goals, setGoals] = useState(false);
  const [kind, setKind] = useState<"all" | (typeof KINDS)[number]>("all");
  const [status, setStatus] = useState<Status>("all");
  const [text, setText] = useState("");
  const views = query.data?.playbooks;
  const wanted = search.id;

  const select = (id: string | undefined) =>
    void navigate({
      to: ".",
      search: (prev: AppSearch): AppSearch => {
        const { id: _drop, ...rest } = prev;
        return id === undefined ? rest : { ...rest, id };
      },
      replace: true,
    });

  const on = views?.filter((v) => v.enabled).length ?? 0;
  const look = views?.filter((v) => v.needsLook).length ?? 0;
  const count = (k: (typeof KINDS)[number]) =>
    views?.filter((v) => kindOf(v.playbook.pack) === k).length ?? 0;
  const needle = text.trim().toLowerCase();
  const shown = (views ?? []).filter(
    (v) =>
      (kind === "all" || kindOf(v.playbook.pack) === kind) &&
      (status === "all" ||
        (status === "on" && v.enabled) ||
        (status === "off" && !v.enabled) ||
        (status === "look" && v.needsLook)) &&
      (needle === "" ||
        v.playbook.name.toLowerCase().includes(needle) ||
        v.playbook.purpose.toLowerCase().includes(needle)),
  );
  const first = shown.find((v) => v.enabled) ?? shown[0];
  const selected =
    (views ?? []).find((v) => v.playbook.id === wanted) ??
    (narrow || wanted !== undefined ? undefined : first);

  let body: React.ReactNode;
  if (query.isError) {
    body = (
      <Problem icon={<ListChecks />} title="Could not load the playbooks" body={describeError(query.error)} />
    );
  } else if (views === undefined) {
    body = <RowsSkeleton rows={8} height={40} />;
  } else {
    const list = (
      <nav
        aria-label="Playbooks"
        className={cn(
          "flex min-w-0 flex-[1.35] flex-col overflow-hidden rounded-2xl max-[999px]:w-full",
          GLASS,
        )}
      >
        <AddPlaybook org={org} onSelect={select} />
        <div className="flex shrink-0 flex-col gap-2 border-b border-line px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <ChoiceChip className={CHIP} pressed={kind === "all"} onClick={() => setKind("all")}>
              All {views.length}
            </ChoiceChip>
            {KINDS.map((k) => (
              <ChoiceChip key={k} className={CHIP} pressed={kind === k} onClick={() => setKind(k)}>
                {KIND_LABEL[k]} {count(k)}
              </ChoiceChip>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <ChoiceChip
              className={CHIP}
              pressed={status === "on"}
              onClick={() => setStatus(status === "on" ? "all" : "on")}
            >
              On {on}
            </ChoiceChip>
            <ChoiceChip
              className={CHIP}
              pressed={status === "off"}
              onClick={() => setStatus(status === "off" ? "all" : "off")}
            >
              Off {views.length - on}
            </ChoiceChip>
            <ChoiceChip
              className={cn(CHIP, look > 0 && "text-accent-text")}
              pressed={status === "look"}
              onClick={() => setStatus(status === "look" ? "all" : "look")}
            >
              Needs a look {look}
            </ChoiceChip>
            {workspaces.length > 1 && (
              <Select
                aria-label="Workspace"
                className="h-7 w-[150px] text-xs"
                value={org}
                onChange={(e) => setOrg(e.target.value === PRIVATE ? undefined : e.target.value)}
              >
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </Select>
            )}
            <div className="relative ml-auto min-w-[150px] flex-1 max-w-[220px]">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-fg-faint"
              />
              <Input
                aria-label="Search playbooks"
                placeholder="Search playbooks"
                className="h-7 pl-7 text-xs"
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
            </div>
          </div>
        </div>
        <div
          className={cn(GRID, "shrink-0 px-4 pt-2 pb-1 text-xs tracking-[0.06em] text-fg-faint uppercase")}
        >
          <span />
          <span>Playbook</span>
          <span>Runs</span>
          <span>Last result</span>
        </div>
        <ul className="m-0 min-h-0 flex-1 list-none overflow-y-auto overscroll-contain px-2 pb-4 scroll-fade">
          {shown.length === 0 ? (
            <li className="px-2 py-3 text-base text-fg-muted">Nothing matches.</li>
          ) : (
            shown.map((v) => (
              <Row
                key={v.playbook.id}
                view={v}
                selected={v.playbook.id === selected?.playbook.id}
                now={now}
                onSelect={() => select(v.playbook.id)}
              />
            ))
          )}
        </ul>
      </nav>
    );
    const pane =
      selected === undefined ? null : (
        <PlaybookDetail
          key={`${org}:${selected.playbook.id}`}
          view={selected}
          now={now}
          workspaces={workspaces}
          onBack={narrow ? () => select(undefined) : undefined}
          onGone={() => select(undefined)}
        />
      );
    body = (
      <ListDetail>
        {narrow ? (pane ?? list) : list}
        {!narrow && pane && <div className="flex min-w-0 flex-1 basis-0">{pane}</div>}
      </ListDetail>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader title="Playbooks">
        <div className="flex items-center gap-4 text-base">
          {views !== undefined && (
            <>
              <span className="text-fg-muted">
                {on} on · {views.length - on} off
              </span>
              {look > 0 && <span className="text-accent-text">{look} needs a look</span>}
            </>
          )}
          <Button onClick={() => setGoals(true)}>
            <Target aria-hidden="true" />
            Goals
          </Button>
        </div>
      </PageHeader>
      {body}
      {goals && (
        <Sheet title="Goals" subtitle="What the work is for" onClose={() => setGoals(false)}>
          <GoalsSection
            org={org}
            workspace={workspaces.find((w) => w.id === org)?.name ?? org}
            views={views ?? []}
          />
        </Sheet>
      )}
    </div>
  );
}
