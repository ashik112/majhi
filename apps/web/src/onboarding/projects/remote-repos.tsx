import type { CloneJob, ClonePhase, MrHost, OnboardingWorkspace, RemoteRepo } from "@majhi/shared";
import { CircleCheck, Lock, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { HostGlyph } from "@/components/host-glyph";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { formatAgo, plural } from "@/lib/format";
import { HOST_LABEL } from "@/lib/hosts";
import { useClone, useCloneStatus, useRemoteRepos } from "@/lib/onboarding-queries";
import { useNow } from "@/lib/use-now";
import { Tick } from "../bits";
import { Problem, useStep } from "../step-frame";
import { RowsLoading } from "./local-repos";
import type { ProjectsWay } from "./projects-step";

interface Source {
  org: string;
  kind: MrHost;
  host: string;
  account: string | undefined;
}

const PHASE: Record<ClonePhase, string> = {
  connecting: "Connecting",
  counting: "Counting objects",
  compressing: "Compressing",
  receiving: "Receiving",
  resolving: "Resolving changes",
  checkout: "Checking out files",
};

function sources(workspaces: readonly OnboardingWorkspace[]): Source[] {
  return workspaces.flatMap((w) =>
    w.git
      .filter((g) => g.signedIn)
      .map((g) => ({ org: w.id, kind: g.kind, host: g.host, account: g.account })),
  );
}

const key = (s: Source) => `${s.org}|${s.kind}|${s.host}`;

/** Repos a workspace's git account can see, with search and paging. Tick to clone; each shows its progress. */
export function RemoteRepos({ onWay }: { onWay: (way: ProjectsWay) => void }) {
  const step = useStep();
  const list = useMemo(() => sources(step.status.workspaces), [step.status.workspaces]);
  const [pick, setPick] = useState<string>();
  const source = list.find((s) => key(s) === pick) ?? list[0];

  if (!source) {
    return (
      <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed border-line-control px-5 py-6">
        <p className="m-0 text-body text-fg-soft">No workspace is signed in to a git host yet.</p>
        <p className="m-0 text-base text-fg-muted">Sign one in and its repos show here, ready to clone.</p>
        <Button className="mt-1" onClick={() => step.goTo("git")}>
          Go to Git accounts
        </Button>
      </div>
    );
  }
  const names = new Map(step.status.workspaces.map((w) => [w.id, w.name]));
  return (
    <div className="flex flex-col gap-4">
      {list.length > 1 && (
        <Select
          aria-label="Repos of"
          value={key(source)}
          onChange={(e) => setPick(e.target.value)}
          className="h-10 w-[320px]"
        >
          {list.map((s) => (
            <option key={key(s)} value={key(s)}>
              {names.get(s.org) ?? s.org}, {HOST_LABEL[s.kind]}
              {s.account ? ` as @${s.account}` : ""}
            </option>
          ))}
        </Select>
      )}
      <RepoBrowser
        key={key(source)}
        source={source}
        workspace={names.get(source.org) ?? source.org}
        onNew={() => onWay("new")}
      />
    </div>
  );
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return v;
}

function RepoBrowser({ source, workspace, onNew }: { source: Source; workspace: string; onNew: () => void }) {
  const step = useStep();
  const [typed, setTyped] = useState("");
  const query = useDebounced(typed.trim(), 300);
  const [page, setPage] = useState(1);
  const [repos, setRepos] = useState<RemoteRepo[]>([]);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [refused, setRefused] = useState<ReadonlyMap<string, string>>(new Map());
  const result = useRemoteRepos({ org: source.org, kind: source.kind, host: source.host, query, page });
  const clone = useClone();
  const jobs = useCloneStatus().data?.jobs ?? [];
  const now = useNow(60_000);
  const data = result.data;

  // A new search starts again at page 1.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on the query only
  useEffect(() => {
    setPage(1);
  }, [query]);
  useEffect(() => {
    if (data?.state !== "ok") return;
    setRepos((old) => {
      if (data.page === 1) return data.repos;
      const seen = new Set(old.map((r) => r.fullName));
      return [...old, ...data.repos.filter((r) => !seen.has(r.fullName))];
    });
  }, [data]);

  const jobFor = (fullName: string) =>
    jobs.find((j) => j.org === source.org && j.fullName === fullName && j.host === source.host);

  async function start() {
    const problems = new Map<string, string>();
    for (const fullName of ticked) {
      try {
        await clone.mutateAsync({ org: source.org, kind: source.kind, host: source.host, fullName });
      } catch (error) {
        problems.set(fullName, describeError(error));
      }
    }
    setRefused(problems);
    setTicked(new Set());
  }

  if (data?.state === "signed-out" || data?.state === "refused") {
    return (
      <div className="flex flex-col items-start gap-3">
        <Problem>
          {data.state === "refused"
            ? `${HOST_LABEL[data.kind]} no longer accepts the saved sign-in for @${data.account}. Sign ${workspace} in again.`
            : `${workspace} is not signed in to ${HOST_LABEL[data.kind]}.`}
        </Problem>
        <Button onClick={() => step.goTo("git")}>Go to Git accounts</Button>
      </div>
    );
  }

  const count = ticked.size;
  const searching = result.isFetching && page === 1;
  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 -mt-1 text-sm text-fg-faint text-pretty">
        Each repo is cloned into the {workspace} folder with {workspace}'s own sign-in, then added as a
        project.
      </p>
      <div className="flex items-center gap-3">
        <div className="relative min-w-0 flex-1">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-fg-faint"
          />
          <Input
            type="search"
            aria-label={`Search ${HOST_LABEL[source.kind]} repos`}
            placeholder={`Search ${source.account ? `@${source.account}'s` : "the"} repos on ${HOST_LABEL[source.kind]}`}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            className="h-10 pl-9 text-body"
          />
          {searching && (
            <span className="absolute top-1/2 right-3 -translate-y-1/2 text-sm text-fg-faint">Searching</span>
          )}
        </div>
        <Button
          variant={step.done || count === 0 ? "secondary" : "primary"}
          size="lg"
          className="w-[168px]"
          disabled={count === 0 || clone.isPending}
          onClick={() => void start()}
        >
          {clone.isPending
            ? "Starting"
            : count === 0
              ? "Tick repos to clone"
              : `Clone ${plural(count, "repo")}`}
        </Button>
      </div>

      {result.isError ? (
        <Problem>{describeError(result.error)}</Problem>
      ) : result.isPending && repos.length === 0 ? (
        <RowsLoading />
      ) : repos.length === 0 ? (
        <p className="m-0 rounded-xl border border-dashed border-line-control px-5 py-6 text-base text-fg-muted">
          {query
            ? `No repo matches "${query}".`
            : `@${source.account ?? workspace} has no repos on ${HOST_LABEL[source.kind]} yet.`}
        </p>
      ) : (
        <ul
          aria-label={`Repos on ${HOST_LABEL[source.kind]}`}
          className={cn(
            "m-0 flex list-none flex-col gap-1.5 p-0 transition-opacity",
            searching && "opacity-60",
          )}
        >
          {repos.map((repo) => (
            <RemoteRow
              key={repo.fullName}
              repo={repo}
              kind={source.kind}
              job={jobFor(repo.fullName)}
              refused={refused.get(repo.fullName)}
              ticked={ticked.has(repo.fullName)}
              now={now}
              onNew={onNew}
              onTick={(on) => {
                const next = new Set(ticked);
                if (on) next.add(repo.fullName);
                else next.delete(repo.fullName);
                setTicked(next);
              }}
            />
          ))}
        </ul>
      )}

      {data?.state === "ok" && data.nextPage !== undefined && (
        <div>
          <Button variant="ghost" disabled={result.isFetching} onClick={() => setPage(data.nextPage ?? page)}>
            {result.isFetching && page > 1 ? "Loading" : "Show more"}
          </Button>
        </div>
      )}
    </div>
  );
}

function RemoteRow({
  repo,
  kind,
  job,
  refused,
  ticked,
  now,
  onNew,
  onTick,
}: {
  repo: RemoteRepo;
  onNew: () => void;
  kind: MrHost;
  job: CloneJob | undefined;
  refused: string | undefined;
  ticked: boolean;
  now: number;
  onTick: (on: boolean) => void;
}) {
  const here = repo.here.state !== "none";
  const busy = job !== undefined && job.state !== "failed";
  return (
    <li
      className={cn(
        "flex min-h-[56px] flex-col justify-center gap-2 rounded-lg border px-3.5 py-2.5 transition-colors duration-150",
        ticked ? "border-accent-line bg-accent-wash" : "border-line-strong bg-card",
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        {here || job?.state === "done" ? (
          <CircleCheck aria-hidden="true" className="size-[18px] shrink-0 text-green" />
        ) : (
          <Tick checked={ticked} disabled={busy} label={`Clone ${repo.fullName}`} onChange={onTick} />
        )}
        <HostGlyph host={kind} className="size-4" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate font-mono text-base text-fg">
              <span className="text-fg-faint">{repo.owner}/</span>
              {repo.name}
            </span>
            {repo.private && <Lock aria-label="Private" className="size-3 shrink-0 text-fg-faint" />}
            {repo.defaultBranch === undefined && (
              <span className="shrink-0 rounded-sm border border-line-strong px-1.5 text-xs text-fg-faint">
                Empty
              </span>
            )}
          </span>
          {repo.description && <span className="truncate text-sm text-fg-muted">{repo.description}</span>}
        </div>
        <span className="shrink-0 text-right text-sm">
          {repo.here.state === "registered" ? (
            <span className="text-green">Already here as {repo.here.project}</span>
          ) : repo.here.state === "cloned" ? (
            <span className="text-fg-muted">On this computer</span>
          ) : job ? null : (
            repo.updatedAt && <span className="text-fg-faint">{formatAgo(repo.updatedAt, now)}</span>
          )}
        </span>
      </div>
      {job && <CloneProgress job={job} />}
      {refused && !job && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 pl-[30px]">
          <span className="min-w-0 text-sm text-pretty text-red">{refused}</span>
          {repo.defaultBranch === undefined && (
            <Button size="sm" onClick={onNew}>
              Start a new project instead
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

function CloneProgress({ job }: { job: CloneJob }) {
  const percent =
    job.state === "cloning"
      ? (job.percent ?? 0)
      : job.state === "registering" || job.state === "done"
        ? 100
        : 0;
  const words =
    job.state === "queued"
      ? "Waiting for the host helper"
      : job.state === "cloning"
        ? PHASE[job.phase]
        : job.state === "registering"
          ? "Adding the project"
          : job.state === "done"
            ? `Added as ${job.project}, on ${job.base}`
            : job.reason;
  return (
    <div className="flex items-center gap-3 pl-[30px]" role="status">
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-sm",
          job.state === "failed" ? "text-red" : job.state === "done" ? "text-green" : "text-fg-muted",
        )}
      >
        {words}
      </span>
      {job.state !== "failed" && job.state !== "done" && (
        <>
          <span className="relative h-[3px] w-[160px] shrink-0 overflow-hidden rounded-full bg-line-strong">
            <span
              className={cn(
                "absolute inset-0 origin-left rounded-full bg-accent transition-transform duration-500 ease-out",
                job.state === "queued" && "animate-pulse",
              )}
              style={{ transform: `scaleX(${job.state === "queued" ? 0.06 : percent / 100})` }}
            />
          </span>
          <span className="w-9 shrink-0 text-right font-mono text-xs text-fg-faint tabular-nums">
            {job.state === "cloning" && job.percent !== undefined ? `${job.percent}%` : ""}
          </span>
        </>
      )}
    </div>
  );
}
