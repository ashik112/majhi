import { PLAYBOOK_PACK_LABEL, PLAYBOOK_PACK_NOTE, type PlaybookView, PRIVATE } from "@majhi/shared";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { ListChecks, SendHorizontal } from "lucide-react";
import { useMemo, useState } from "react";
import { Problem } from "@/components/problem";
import { Button } from "@/components/ui/button";
import { ChoiceChip } from "@/components/ui/choice-chip";
import { Lamp } from "@/components/ui/lamp";
import { ListDetail, ListPane, ROW, ROW_SELECTED } from "@/components/ui/list-detail";
import { PageHeader } from "@/components/ui/page-header";
import { RowsSkeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { formatAgo } from "@/lib/format";
import { useOrgFilter } from "@/lib/org-filter";
import { usePlaybooks, useUpdatePlaybook } from "@/lib/playbook-queries";
import { useOrgs } from "@/lib/studio-queries";
import { useMedia } from "@/lib/use-media";
import { useNow } from "@/lib/use-now";
import type { AppSearch } from "@/router";
import { PlaybookDetail } from "./detail";
import { GoalsSection } from "./goals";
import { byPack, formatIn, lampOf, outcomeText } from "./model";
import { OutboundSheet } from "./outbound-sheet";

const CHIP = "min-h-7 px-2.5 text-xs";

/** One playbook in the list: the switch, its name, and a second line of when and what came of it. */
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
  const second = view.held !== undefined && view.enabled ? view.held : outcomeText(view.counters);
  const when = !view.enabled
    ? view.playbook.needs === undefined
      ? "Off"
      : "Needs a sensor"
    : view.running
      ? "Running now"
      : view.held !== undefined
        ? "Held"
        : view.nextRun !== undefined
          ? `Next ${formatIn(view.nextRun, now)}`
          : view.lastRun !== undefined
            ? `Last ${formatAgo(view.lastRun, now)}`
            : "Waits for its event";
  return (
    <li className="flex min-w-0 items-stretch gap-1">
      <button
        type="button"
        data-playbook={view.playbook.id}
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
        className={cn(ROW, "min-w-0 flex-1 flex-col gap-1 px-2.5 py-2", selected && ROW_SELECTED)}
      >
        <span className="flex min-w-0 items-center gap-2">
          <Lamp state={lampOf(view)} size={7} />
          <span
            className={cn("min-w-0 flex-1 truncate text-base", view.enabled ? "text-fg" : "text-fg-muted")}
          >
            {view.playbook.name}
          </span>
          <span className="shrink-0 text-xs text-fg-faint">{when}</span>
        </span>
        <span
          className={cn(
            "min-w-0 truncate pl-[15px] text-xs",
            view.held !== undefined && view.enabled ? "text-amber" : "text-fg-faint",
          )}
          title={second}
        >
          {second}
        </span>
      </button>
      <div className="flex shrink-0 items-center pr-1">
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
      </div>
    </li>
  );
}

/**
 * The Playbooks page (`/playbooks`, SPEC 5.18): the captain's standing work, grouped by pack, with a
 * switch and the next run on each row; the selected one in full on the right, with its steps, budget
 * and history. Goals sit under the list. Below 1000px the pane is the page and the list its back view.
 */
export function PlaybooksView() {
  const orgs = useOrgs().data ?? [];
  const { org: filter, setOrg } = useOrgFilter();
  const org = filter ?? PRIVATE;
  const workspaces = useMemo(
    () => [{ id: PRIVATE, name: "Private" }, ...orgs.filter((o) => o.id !== PRIVATE)],
    [orgs],
  );
  const query = usePlaybooks(org);
  const now = useNow(30_000);
  const narrow = useMedia("(max-width: 999px)");
  const search: AppSearch = useSearch({ strict: false });
  const navigate = useNavigate();
  const [outbound, setOutbound] = useState(false);
  const views = query.data?.playbooks;
  const groups = useMemo(() => byPack(views ?? []), [views]);
  const wanted = search.id;
  const first = views?.find((v) => v.enabled) ?? views?.[0];
  const selected =
    views?.find((v) => v.playbook.id === wanted) ?? (narrow || wanted !== undefined ? undefined : first);

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
  const held = views?.filter((v) => v.enabled && v.held !== undefined).length ?? 0;
  const subtitle =
    views === undefined
      ? "The captain's standing work, switched on or off per workspace."
      : `${on} of ${views.length} on${held > 0 ? `, ${held} held` : ""}`;

  let body: React.ReactNode;
  if (query.isError) {
    body = (
      <Problem icon={<ListChecks />} title="Could not load the playbooks" body={describeError(query.error)} />
    );
  } else if (views === undefined) {
    body = <RowsSkeleton rows={5} height={52} />;
  } else {
    const list = (
      <ListPane label="Playbooks" className="w-[340px] min-[1320px]:w-[380px] max-[999px]:w-full">
        {groups.map((g) => (
          <section key={g.pack} aria-label={PLAYBOOK_PACK_LABEL[g.pack]} className="mb-3">
            <div className="px-2.5 pt-1.5 pb-1">
              <h2 className="m-0 text-sm font-semibold text-fg">{PLAYBOOK_PACK_LABEL[g.pack]}</h2>
              <p className="m-0 text-xs text-fg-faint text-pretty">{PLAYBOOK_PACK_NOTE[g.pack]}</p>
            </div>
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
              {g.views.map((v) => (
                <Row
                  key={v.playbook.id}
                  view={v}
                  selected={v.playbook.id === selected?.playbook.id}
                  now={now}
                  onSelect={() => select(v.playbook.id)}
                />
              ))}
            </ul>
          </section>
        ))}
        <GoalsSection org={org} workspace={workspaces.find((w) => w.id === org)?.name ?? org} views={views} />
      </ListPane>
    );
    const pane =
      selected === undefined ? null : (
        <PlaybookDetail
          key={`${org}:${selected.playbook.id}`}
          view={selected}
          now={now}
          onBack={narrow ? () => select(undefined) : undefined}
        />
      );
    body = (
      <ListDetail>
        {narrow ? (pane ?? list) : list}
        {!narrow && pane}
      </ListDetail>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader title="Playbooks" subtitle={subtitle}>
        <Button onClick={() => setOutbound(true)}>
          <SendHorizontal aria-hidden="true" />
          Sending
        </Button>
      </PageHeader>
      {workspaces.length > 1 && (
        <fieldset
          aria-label="Workspace"
          className="m-0 mb-3 flex min-w-0 flex-wrap items-center gap-1.5 border-0 p-0"
        >
          {workspaces.map((w) => (
            <ChoiceChip
              key={w.id}
              className={`${CHIP} max-w-[170px]`}
              pressed={org === w.id}
              onClick={() => setOrg(w.id === PRIVATE ? undefined : w.id)}
            >
              <span className="min-w-0 truncate">{w.name}</span>
            </ChoiceChip>
          ))}
        </fieldset>
      )}
      {body}
      {outbound && <OutboundSheet org={org} onClose={() => setOutbound(false)} />}
    </div>
  );
}
