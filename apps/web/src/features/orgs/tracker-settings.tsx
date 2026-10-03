import {
  DEFAULT_TRACKER_STATUSES,
  type OrgView,
  type ProjectView,
  TRACKER_LABEL,
  type TrackerConfig,
  TrackerConfigSchema,
  type TrackerPullEvery,
  type TrackerStage,
  type TrackerType,
} from "@majhi/shared";
import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { DetailSection } from "@/components/ui/list-detail";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { describeError } from "@/lib/errors";
import { formatAgo, plural } from "@/lib/format";
import { useSaveSecret, useUpdateOrg } from "@/lib/studio-queries";
import { useTestTracker, useTrackerCommand, useTrackerStatus } from "@/lib/tracker-queries";
import { useNow } from "@/lib/use-now";

interface Draft {
  type: TrackerType | "";
  site: string;
  email: string;
  project: string;
  list: string;
  repo: string;
  assigned: boolean;
  pullEvery: TrackerPullEvery;
  statuses: Partial<Record<TrackerStage, string>>;
}

const STAGES: { stage: TrackerStage; label: string }[] = [
  { stage: "working", label: "Working" },
  { stage: "review", label: "In review" },
  { stage: "done", label: "Done" },
];

const PULL_LABEL: Record<TrackerPullEvery, string> = {
  off: "Only when I click Pull now",
  "15m": "Every 15 minutes",
  "1h": "Every hour",
  "6h": "Every 6 hours",
};

const TOKEN_HINT: Record<TrackerType, string> = {
  jira: "An Atlassian API token of that account.",
  clickup: "A ClickUp personal token (Settings, Apps).",
  github: "A token that can read and write issues. Empty: the org's GitHub token.",
};

function draftOf(t: TrackerConfig | undefined): Draft {
  return {
    type: t?.type ?? "",
    site: t?.type === "jira" ? t.site : "",
    email: t?.type === "jira" ? t.email : "",
    project: t?.type === "jira" ? (t.project ?? "") : "",
    list: t?.type === "clickup" ? t.list : "",
    repo: t?.type === "github" ? t.repo : "",
    assigned: t?.assigned ?? true,
    pullEvery: t?.pull_every ?? "1h",
    statuses: t?.statuses ?? {},
  };
}

/** The config to save, or the first problem in plain words. */
function configOf(d: Draft, token: string | undefined): TrackerConfig | string {
  if (d.type === "") return "Pick a tracker.";
  const statuses = Object.fromEntries(
    Object.entries(d.statuses).filter(([, v]) => v !== undefined && v.trim() !== ""),
  );
  const common = {
    ...(d.assigned ? {} : { assigned: false }),
    ...(d.pullEvery === "1h" ? {} : { pull_every: d.pullEvery }),
    ...(Object.keys(statuses).length === 0 ? {} : { statuses }),
  };
  const raw =
    d.type === "jira"
      ? {
          type: d.type,
          site: d.site,
          email: d.email,
          token,
          ...(d.project ? { project: d.project } : {}),
          ...common,
        }
      : d.type === "clickup"
        ? { type: d.type, list: d.list, token, ...common }
        : { type: d.type, repo: d.repo, ...(token === undefined ? {} : { token }), ...common };
  if (d.type !== "github" && token === undefined) return "Paste the token.";
  const parsed = TrackerConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : (parsed.error.issues[0]?.message ?? "Check the fields.");
}

/**
 * The org's tracker (5.11): Jira, ClickUp or GitHub Issues. Items assigned to the owner land in Up
 * next on a schedule or on Pull now. Items with no clear project wait here for one.
 */
export function TrackerSettings({ org, projects }: { org: OrgView; projects: readonly ProjectView[] }) {
  const current = org.tracker;
  const [draft, setDraft] = useState<Draft>(() => draftOf(current));
  const [token, setToken] = useState("");
  const [failure, setFailure] = useState<string>();
  const [busy, setBusy] = useState(false);
  const save = useSaveSecret();
  const update = useUpdateOrg();
  const test = useTestTracker();
  const pull = useTrackerCommand("trackers.pull");
  const status = useTrackerStatus(org.id, current !== undefined);
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const type = draft.type;
  const sameType = current !== undefined && current.type === type;

  const onSave = async () => {
    setFailure(undefined);
    const keep = sameType ? current.token : undefined;
    const typed = token.trim();
    const check = configOf(draft, typed !== "" ? "secret:pending" : keep);
    if (typeof check === "string") return setFailure(check);
    setBusy(true);
    try {
      const ref =
        typed === ""
          ? keep
          : (await save.mutateAsync({ value: typed, label: `${org.id} ${type} tracker token` })).ref;
      const config = configOf(draft, ref);
      if (typeof config === "string") throw new Error(config);
      await update.mutateAsync({ id: org.id, tracker: config });
      setToken("");
      test.reset();
    } catch (e) {
      setFailure(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const onRemove = async () => {
    setFailure(undefined);
    try {
      await update.mutateAsync({ id: org.id, tracker: null });
      setDraft(draftOf(undefined));
      setToken("");
    } catch (e) {
      setFailure(describeError(e));
    }
  };

  return (
    <DetailSection
      title="Tracker"
      note={
        current === undefined
          ? "Pull items into Up next and write MR links back."
          : `${TRACKER_LABEL[current.type]}. ${PULL_LABEL[current.pull_every ?? "1h"]}.`
      }
      actions={
        current !== undefined && (
          <>
            <Button size="sm" variant="ghost" disabled={test.isPending} onClick={() => test.mutate(org.id)}>
              Test
            </Button>
            <Button size="sm" disabled={pull.isPending} onClick={() => pull.mutate({ org: org.id })}>
              {pull.isPending ? "Pulling" : "Pull now"}
            </Button>
          </>
        )
      }
    >
      {test.data && (
        <p role="status" className={test.data.ok ? "m-0 text-sm text-green" : "m-0 text-sm text-red"}>
          {test.data.detail}
        </p>
      )}
      {test.error && (
        <p role="alert" className="m-0 text-sm text-red">
          {describeError(test.error)}
        </p>
      )}
      {current !== undefined && <PullStatus org={org.id} projects={projects} status={status.data} />}
      {pull.error && (
        <p role="alert" className="m-0 text-sm text-red">
          {describeError(pull.error)}
        </p>
      )}

      <div className="grid gap-3 @[620px]:grid-cols-2">
        <Field label="Tracker">
          {(p) => (
            <Select {...p} value={type} onChange={(e) => set({ type: e.target.value as TrackerType | "" })}>
              <option value="">None</option>
              <option value="jira">{TRACKER_LABEL.jira}</option>
              <option value="clickup">{TRACKER_LABEL.clickup}</option>
              <option value="github">{TRACKER_LABEL.github}</option>
            </Select>
          )}
        </Field>
        {type === "jira" && (
          <>
            <Field label="Site">
              {(p) => (
                <Input
                  {...p}
                  placeholder="acme.atlassian.net"
                  value={draft.site}
                  onChange={(e) => set({ site: e.target.value })}
                />
              )}
            </Field>
            <Field label="Account email">
              {(p) => (
                <Input
                  {...p}
                  type="email"
                  placeholder="owner@acme.com"
                  value={draft.email}
                  onChange={(e) => set({ email: e.target.value })}
                />
              )}
            </Field>
            <Field label="Project key for pushed tasks" hint="Optional. Without it, tasks cannot be pushed.">
              {(p) => (
                <Input
                  {...p}
                  placeholder="ACME"
                  value={draft.project}
                  onChange={(e) => set({ project: e.target.value.toUpperCase() })}
                />
              )}
            </Field>
          </>
        )}
        {type === "clickup" && (
          <Field label="List id" hint="The number in the list's address.">
            {(p) => (
              <Input
                {...p}
                placeholder="901234567"
                value={draft.list}
                onChange={(e) => set({ list: e.target.value })}
              />
            )}
          </Field>
        )}
        {type === "github" && (
          <Field label="Repo">
            {(p) => (
              <Input
                {...p}
                placeholder="acme/web"
                value={draft.repo}
                onChange={(e) => set({ repo: e.target.value })}
              />
            )}
          </Field>
        )}
        {type !== "" && (
          <>
            <Field label="Token" hint={TOKEN_HINT[type]}>
              {(p) => (
                <Input
                  {...p}
                  type="password"
                  autoComplete="new-password"
                  placeholder={sameType && current.token !== undefined ? "Saved. Paste to replace." : ""}
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                />
              )}
            </Field>
            <Field label="Pull">
              {(p) => (
                <Select
                  {...p}
                  value={draft.pullEvery}
                  onChange={(e) => set({ pullEvery: e.target.value as TrackerPullEvery })}
                >
                  {(Object.keys(PULL_LABEL) as TrackerPullEvery[]).map((k) => (
                    <option key={k} value={k}>
                      {PULL_LABEL[k]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </>
        )}
      </div>

      {type !== "" && (
        <>
          <Switch
            label="Only items assigned to me"
            checked={draft.assigned}
            onChange={(assigned) => set({ assigned })}
          />
          <div className="flex flex-col gap-1.5">
            <span className="text-sm text-fg-faint">Status names majhi sets</span>
            <div className="grid gap-3 @[620px]:grid-cols-3">
              {STAGES.filter((s) => type !== "github" || s.stage === "done").map((s) => (
                <Input
                  key={s.stage}
                  aria-label={`Status for ${s.label}`}
                  placeholder={`${s.label}: ${DEFAULT_TRACKER_STATUSES[type][s.stage] ?? ""}`}
                  value={draft.statuses[s.stage] ?? ""}
                  onChange={(e) => set({ statuses: { ...draft.statuses, [s.stage]: e.target.value } })}
                />
              ))}
            </div>
          </div>
        </>
      )}

      {failure && (
        <p role="alert" className="m-0 text-sm text-red">
          {failure}
        </p>
      )}
      <div className="flex items-center gap-2">
        {type !== "" && (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void onSave()}>
            Save tracker
          </Button>
        )}
        {current !== undefined && (
          <Button size="sm" variant="ghost" disabled={update.isPending} onClick={() => void onRemove()}>
            Remove tracker
          </Button>
        )}
      </div>
    </DetailSection>
  );
}

/** The last pull, and the items it could not route, each with a project picker. */
function PullStatus({
  org,
  projects,
  status,
}: {
  org: string;
  projects: readonly ProjectView[];
  status: ReturnType<typeof useTrackerStatus>["data"];
}) {
  const now = useNow(30_000);
  const take = useTrackerCommand("trackers.take");
  const [picked, setPicked] = useState<Record<string, string>>({});
  const last = status?.last;
  const unrouted = status?.unrouted ?? [];
  return (
    <>
      {last && (
        <p className={last.error ? "m-0 text-sm text-red" : "m-0 text-sm text-fg-muted"}>
          {last.error
            ? `Last pull failed ${formatAgo(last.at, now)}: ${last.error}`
            : `Pulled ${formatAgo(last.at, now)}: ${plural(last.seen, "item")}, ${last.created.length} new.`}
        </p>
      )}
      {unrouted.length > 0 && (
        <ul aria-label="Items waiting for a project" className="flex flex-col">
          {unrouted.map((u) => (
            <li
              key={u.key}
              className="flex min-h-9 min-w-0 items-center gap-3 border-t border-line py-1.5 first:border-t-0"
            >
              <a
                href={u.url}
                target="_blank"
                rel="noreferrer"
                className="flex min-w-0 items-center gap-1.5 text-sm text-fg underline-offset-2 hover:underline"
                title={u.why}
              >
                <span className="shrink-0 font-mono text-fg-soft">{u.key}</span>
                <span className="truncate">{u.title}</span>
                <ExternalLink aria-hidden="true" className="size-3 shrink-0 text-fg-faint" />
              </a>
              <Select
                aria-label={`Project for ${u.key}`}
                className="ml-auto w-[160px] shrink-0"
                value={picked[u.key] ?? ""}
                onChange={(e) => setPicked((p) => ({ ...p, [u.key]: e.target.value }))}
              >
                <option value="">No project (chat)</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.id}
                  </option>
                ))}
              </Select>
              <Button
                size="sm"
                variant="secondary"
                disabled={take.isPending}
                onClick={() => {
                  const project = picked[u.key];
                  take.mutate({ org, key: u.key, ...(project ? { project } : {}) });
                }}
              >
                Take
              </Button>
            </li>
          ))}
        </ul>
      )}
      {take.error && (
        <p role="alert" className="m-0 text-sm text-red">
          {describeError(take.error)}
        </p>
      )}
    </>
  );
}
