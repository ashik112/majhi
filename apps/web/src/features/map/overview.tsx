import type { MapAnswer, MapEndpoint, MapView } from "@majhi/shared";
import { endpointId } from "@majhi/shared";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";
import type { Selection } from "@/features/diagram/diagram-canvas";
import { useAnswerAddress, useConfirmEdge, useRemoveEdge } from "@/lib/map-queries";
import { type MapPrefs, needsReview, unansweredAddresses } from "./model";

export type OverviewTab = "projects" | "review" | "addresses";

/** The side panel when no box or line is picked: which projects to show, what to check, which addresses to name. */
export function Overview({
  view,
  tab,
  onTab,
  prefs,
  onPrefs,
  onSelect,
}: {
  view: MapView;
  tab: OverviewTab;
  onTab: (tab: OverviewTab) => void;
  prefs: MapPrefs;
  onPrefs: (prefs: MapPrefs) => void;
  onSelect: (selection: Selection) => void;
}) {
  const review = view.map.edges.filter(needsReview);
  const addresses = unansweredAddresses(view);
  return (
    <>
      <Segmented
        label="Panel"
        value={tab}
        onChange={onTab}
        segments={[
          { value: "projects", label: "Projects" },
          { value: "review", label: "Review", count: review.length },
          { value: "addresses", label: "Addresses", count: addresses.length },
        ]}
      />
      {tab === "projects" && <ProjectsList view={view} prefs={prefs} onPrefs={onPrefs} />}
      {tab === "review" && <ReviewList view={view} lines={review} onSelect={onSelect} />}
      {tab === "addresses" && <AddressList view={view} addresses={addresses} />}
    </>
  );
}

function ProjectsList({
  view,
  prefs,
  onPrefs,
}: {
  view: MapView;
  prefs: MapPrefs;
  onPrefs: (prefs: MapPrefs) => void;
}) {
  const [search, setSearch] = useState("");
  const projects = view.map.nodes.filter((n) => n.project !== undefined);
  const shown = projects.filter((n) => n.label.toLowerCase().includes(search.trim().toLowerCase()));
  const hidden = new Set(prefs.hidden);
  const toggle = (id: string, on: boolean) => {
    const next = new Set(hidden);
    if (on) next.delete(id);
    else next.add(id);
    onPrefs({ ...prefs, hidden: [...next] });
  };
  return (
    <div className="flex flex-col gap-3">
      <label className="flex items-center gap-2 text-base text-fg-soft">
        <input
          type="checkbox"
          checked={prefs.hideAlone}
          onChange={(e) => onPrefs({ ...prefs, hideAlone: e.target.checked })}
        />
        Hide not connected
      </label>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => onPrefs({ ...prefs, hidden: [] })}>
          All
        </Button>
        <Button size="sm" onClick={() => onPrefs({ ...prefs, hidden: projects.map((n) => n.id) })}>
          None
        </Button>
        <span className="ml-auto text-sm text-fg-muted">
          {projects.length - hidden.size} of {projects.length}
        </span>
      </div>
      {projects.length > 8 && (
        <Input
          aria-label="Find a project"
          placeholder="Find"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      )}
      <ul className="flex flex-col">
        {shown.map((n) => (
          <li key={n.id}>
            <label className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-base text-fg-soft hover:bg-raised">
              <input
                type="checkbox"
                checked={!hidden.has(n.id)}
                onChange={(e) => toggle(n.id, e.target.checked)}
              />
              <span className="truncate font-mono text-sm text-fg">{n.label}</span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReviewList({
  view,
  lines,
  onSelect,
}: {
  view: MapView;
  lines: MapView["map"]["edges"];
  onSelect: (selection: Selection) => void;
}) {
  const confirm = useConfirmEdge(view.org);
  const remove = useRemoveEdge(view.org);
  if (lines.length === 0) return <p className="text-base text-fg-faint">Nothing to check.</p>;
  const name = (id: string) => view.map.nodes.find((n) => n.id === id)?.label ?? id;
  return (
    <ul className="flex flex-col gap-3">
      {lines.map((e) => (
        <li key={e.id} className="flex flex-col gap-1.5 rounded-lg border border-line p-2.5">
          <button
            type="button"
            onClick={() => onSelect({ kind: "edge", id: e.id })}
            className="cursor-pointer truncate text-left font-mono text-sm text-fg"
          >
            {name(e.from)} to {name(e.to)}
          </button>
          {e.evidence[0] !== undefined && (
            <pre className="overflow-x-auto rounded-md border border-line bg-sunken px-2 py-1.5 font-mono text-xs break-all whitespace-pre-wrap text-fg-soft">
              {e.evidence[0].file}:{e.evidence[0].line} {e.evidence[0].excerpt}
            </pre>
          )}
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={confirm.isPending}
              onClick={() => confirm.mutate(e.id)}
            >
              Accept
            </Button>
            <Button size="sm" disabled={remove.isPending} onClick={() => remove.mutate(e.id)}>
              Dismiss
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** `host` or `host:port` as the answer command takes it. */
export function addressText(e: Pick<MapEndpoint, "host" | "port">): string {
  return e.port === undefined ? e.host : `${e.host}:${e.port}`;
}

function AddressList({ view, addresses }: { view: MapView; addresses: MapEndpoint[] }) {
  const answer = useAnswerAddress(view.org);
  const projects = view.map.nodes.filter((n) => n.project !== undefined);
  const say = (e: MapEndpoint, to: MapAnswer | undefined) =>
    answer.mutate({
      address: addressText(e),
      ...(e.scope === undefined ? {} : { scope: e.scope }),
      ...(to === undefined ? {} : { to }),
    });
  const given = view.map.resolutions;
  return (
    <div className="flex flex-col gap-4">
      {addresses.length === 0 ? (
        <p className="text-base text-fg-faint">Every address has an answer.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {addresses.map((e) => {
            const from = [...new Set(e.refs.map((r) => r.project))];
            return (
              <li key={e.id} className="flex flex-col gap-1.5 rounded-lg border border-line p-2.5">
                <span className="truncate text-base text-fg" title={e.id}>
                  Talks to <span className="font-mono text-sm">{addressText(e)}</span>
                </span>
                <span
                  className="truncate text-sm text-fg-muted"
                  title={e.refs.map((r) => `${r.project}/${r.file}:${r.line}`).join("\n")}
                >
                  From {from.join(", ")}
                </span>
                <div className="flex gap-2">
                  <Select
                    aria-label={`Which project is ${addressText(e)}`}
                    value=""
                    disabled={answer.isPending}
                    onChange={(ev) =>
                      ev.target.value !== "" && say(e, { kind: "project", project: ev.target.value })
                    }
                    className="h-7 min-w-0 flex-1 text-sm"
                  >
                    <option value="">Which project?</option>
                    {projects
                      .filter((n) => !(from.length === 1 && from[0] === n.id))
                      .map((n) => (
                        <option key={n.id} value={n.id}>
                          {n.label}
                        </option>
                      ))}
                  </Select>
                  <Button size="sm" disabled={answer.isPending} onClick={() => say(e, { kind: "outside" })}>
                    Outside
                  </Button>
                  <Button size="sm" disabled={answer.isPending} onClick={() => say(e, { kind: "ignore" })}>
                    Ignore
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {given.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="font-mono text-xs tracking-[0.06em] text-fg-muted uppercase">Your answers</span>
          {given.map((r) => (
            <div key={endpointId(r.host, r.port, r.scope)} className="flex items-center gap-2 text-sm">
              <span
                className="min-w-0 flex-1 truncate font-mono text-fg"
                title={endpointId(r.host, r.port, r.scope)}
              >
                {addressText(r)}
              </span>
              <span className="shrink-0 text-fg-muted">
                {r.to.kind === "project" ? r.to.project : r.to.kind === "outside" ? "outside" : "ignored"}
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={answer.isPending}
                onClick={() =>
                  answer.mutate({
                    address: addressText(r),
                    ...(r.scope === undefined ? {} : { scope: r.scope }),
                  })
                }
              >
                Forget
              </Button>
            </div>
          ))}
        </div>
      )}
      {answer.error !== null && (
        <p role="alert" className="text-sm text-red">
          {answer.error.message}
        </p>
      )}
    </div>
  );
}
