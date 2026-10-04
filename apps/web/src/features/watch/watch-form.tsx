import {
  PRIVATE,
  WATCH_KIND_ONE,
  WATCH_KINDS,
  type WatchDef,
  WatchDefSchema,
  type WatchSort,
  type WatchTestResult,
} from "@majhi/shared";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Sheet } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import {
  type ActionDraft,
  ActionFields,
  actionToDraft,
  draftToAction,
  EMPTY_ACTION,
} from "@/features/actions/action-fields";
import { useConnections } from "@/lib/connection-queries";
import { describeError } from "@/lib/errors";
import { useOrgs } from "@/lib/studio-queries";
import { useProjects } from "@/lib/task-queries";
import { useSaveWatch, useTestWatch } from "@/lib/watch-queries";

/** The plain form: every field of a watch, for the owner who would rather not use a sentence. */
interface Draft {
  name: string;
  kind: WatchSort;
  url: string;
  keyword: string;
  jsonPath: string;
  expectStatus: string;
  connection: string;
  engine: "postgres" | "mysql";
  query: string;
  label: string;
  unit: string;
  redisMetric: "memory_ratio" | "clients" | "keys" | "info";
  infoField: string;
  serverMetric: "disk" | "cpu" | "memory";
  path: string;
  source: "redis_list" | "sql";
  key: string;
  mode: "value" | "text";
  selector: string;
  pattern: string;
  compare: string;
  tool: string;
  args: string;
  metricPath: string;
  instruction: string;
  ctype: "above" | "below" | "changed" | "contains" | "notContains" | "down";
  value: string;
  forMin: string;
  text: string;
  everyMin: string;
  project: string;
  /** "A URL changes": a page's text watched for any change. */
  urlChange: boolean;
  /** Run an action when it fires. */
  actOn: boolean;
  act: ActionDraft;
  actSkip: boolean;
  /** Also raise an alert (an incident). */
  alert: boolean;
}

function emptyDraft(kind: WatchSort = "website"): Draft {
  return {
    name: "",
    kind,
    url: "",
    keyword: "",
    jsonPath: "",
    expectStatus: "",
    connection: "",
    engine: "postgres",
    query: "",
    label: "",
    unit: "",
    redisMetric: "memory_ratio",
    infoField: "",
    serverMetric: "disk",
    path: kind === "path" ? "" : "/",
    source: "redis_list",
    key: "",
    mode: "value",
    selector: "",
    pattern: "",
    compare: "",
    tool: "",
    args: "{}",
    metricPath: "",
    instruction: "",
    ctype: kind === "website" ? "down" : kind === "path" ? "changed" : "above",
    value: "",
    forMin: "0",
    text: "",
    everyMin: kind === "price" ? "360" : kind === "custom" ? "1440" : "5",
    project: "",
    urlChange: false,
    actOn: false,
    act: EMPTY_ACTION,
    actSkip: true,
    alert: true,
  };
}

function draftOf(def: WatchDef): Draft {
  const d = emptyDraft(def.spec.kind);
  d.name = def.name;
  d.everyMin = String(def.everyMin);
  d.project = def.project ?? "";
  d.alert = def.fire.alert.on;
  if (def.fire.run !== undefined) {
    d.actOn = true;
    d.act = actionToDraft(def.fire.run);
  }
  d.actSkip = def.fire.runOverlap === "skip";
  const c = def.condition;
  d.ctype = c.type;
  if (c.type === "above" || c.type === "below") {
    d.value = String(c.value);
    d.forMin = String(c.forMin);
  }
  if (c.type === "contains" || c.type === "notContains") d.text = c.text;
  const s = def.spec;
  switch (s.kind) {
    case "website":
      d.url = s.url;
      d.keyword = s.keyword ?? "";
      d.jsonPath = s.jsonPath ?? "";
      d.expectStatus = s.expectStatus === undefined ? "" : String(s.expectStatus);
      break;
    case "database":
      d.connection = s.connection;
      d.engine = s.engine;
      d.query = s.query;
      d.label = s.label ?? "";
      d.unit = s.unit ?? "";
      break;
    case "redis":
      d.connection = s.connection;
      d.redisMetric = s.metric;
      d.infoField = s.infoField ?? "";
      break;
    case "server":
      d.connection = s.connection;
      d.serverMetric = s.metric;
      d.path = s.path;
      break;
    case "queue":
      d.connection = s.connection;
      d.source = s.source;
      d.key = s.key ?? "";
      d.engine = s.engine ?? "postgres";
      d.query = s.query ?? "";
      break;
    case "price":
      d.url = s.url;
      d.mode = s.mode;
      d.selector = s.selector ?? "";
      d.pattern = s.pattern ?? "";
      d.compare = s.compare.join("\n");
      d.urlChange =
        s.mode === "text" &&
        c.type === "changed" &&
        d.selector === "" &&
        d.pattern === "" &&
        s.compare.length === 0;
      break;
    case "path":
      d.project = s.project;
      d.path = s.path;
      break;
    case "metric":
      d.connection = s.connection;
      d.tool = s.tool;
      d.args = s.args;
      d.metricPath = s.path;
      d.label = s.label ?? "";
      d.unit = s.unit ?? "";
      break;
    case "custom":
      d.instruction = s.instruction;
      break;
  }
  return d;
}

const opt = (v: string) => (v.trim() === "" ? {} : { v: v.trim() });

function specOf(d: Draft): unknown {
  switch (d.kind) {
    case "website":
      return {
        kind: "website",
        url: d.url.trim(),
        ...(opt(d.keyword).v === undefined ? {} : { keyword: d.keyword.trim() }),
        ...(opt(d.jsonPath).v === undefined ? {} : { jsonPath: d.jsonPath.trim() }),
        ...(d.expectStatus.trim() === "" ? {} : { expectStatus: Number(d.expectStatus) }),
      };
    case "database":
      return {
        kind: "database",
        connection: d.connection,
        engine: d.engine,
        query: d.query,
        ...(opt(d.label).v === undefined ? {} : { label: d.label.trim() }),
        ...(opt(d.unit).v === undefined ? {} : { unit: d.unit.trim() }),
      };
    case "redis":
      return {
        kind: "redis",
        connection: d.connection,
        metric: d.redisMetric,
        ...(d.redisMetric === "info" ? { infoField: d.infoField.trim() } : {}),
      };
    case "server":
      return { kind: "server", connection: d.connection, metric: d.serverMetric, path: d.path.trim() || "/" };
    case "queue":
      return d.source === "redis_list"
        ? { kind: "queue", connection: d.connection, source: "redis_list", key: d.key.trim() }
        : { kind: "queue", connection: d.connection, source: "sql", engine: d.engine, query: d.query };
    case "price":
      return {
        kind: "price",
        url: d.url.trim(),
        mode: d.mode,
        ...(opt(d.selector).v === undefined ? {} : { selector: d.selector.trim() }),
        ...(opt(d.pattern).v === undefined ? {} : { pattern: d.pattern.trim() }),
        compare: d.compare
          .split(/\s+/)
          .map((x) => x.trim())
          .filter((x) => x !== ""),
      };
    case "metric":
      return {
        kind: "metric",
        connection: d.connection,
        tool: d.tool.trim(),
        args: d.args,
        path: d.metricPath.trim(),
        ...(opt(d.label).v === undefined ? {} : { label: d.label.trim() }),
        ...(opt(d.unit).v === undefined ? {} : { unit: d.unit.trim() }),
      };
    case "path":
      return { kind: "path", project: d.project, path: d.path.trim() };
    case "custom":
      return { kind: "custom", instruction: d.instruction.trim() };
  }
}

function conditionOf(d: Draft): unknown {
  if (d.ctype === "above" || d.ctype === "below") {
    return { type: d.ctype, value: Number(d.value), forMin: Number(d.forMin || "0") };
  }
  if (d.ctype === "contains" || d.ctype === "notContains") return { type: d.ctype, text: d.text.trim() };
  return { type: d.ctype };
}

const CONN_TYPE: Partial<Record<WatchSort, string>> = {
  database: "env",
  redis: "env",
  queue: "env",
  server: "ssh",
  metric: "mcp",
};

const EVERY = [
  { v: "1", l: "1 minute" },
  { v: "5", l: "5 minutes" },
  { v: "10", l: "10 minutes" },
  { v: "15", l: "15 minutes" },
  { v: "30", l: "30 minutes" },
  { v: "60", l: "1 hour" },
  { v: "360", l: "6 hours" },
  { v: "1440", l: "1 day" },
];

export function WatchForm({
  watch,
  start,
  org: initialOrg,
  onClose,
}: {
  /** Editing: the watch's id, workspace and definition. */
  watch?: { id: string; org: string; def: WatchDef } | undefined;
  /** A plan to fine-tune before it starts. */
  start?: { org: string; def: WatchDef } | undefined;
  org: string;
  onClose: () => void;
}) {
  const source = watch?.def ?? start?.def;
  const [org, setOrg] = useState(watch?.org ?? start?.org ?? initialOrg);
  const [d, setD] = useState<Draft>(() => (source === undefined ? emptyDraft() : draftOf(source)));
  const [result, setResult] = useState<WatchTestResult | undefined>();
  const [problem, setProblem] = useState<string | undefined>();
  const orgs = useOrgs().data ?? [];
  const connections = useConnections().data ?? [];
  const projects = useProjects().data ?? [];
  const save = useSaveWatch();
  const test = useTestWatch();
  const toast = useToast();
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setD((prev) => ({ ...prev, [key]: value }));
    setResult(undefined);
  };
  const workspaces = [{ id: PRIVATE, name: "Private" }, ...orgs.filter((o) => o.id !== PRIVATE)];
  const wanted = CONN_TYPE[d.kind] ?? (d.kind === "queue" ? "env" : undefined);
  const choices = connections.filter((c) => c.org === org && (wanted === undefined || c.type === wanted));
  const mine = projects.filter((p) => p.org === org);

  /** The form as a watch, with the fire settings kept from what was there. */
  const build = (): WatchDef | undefined => {
    let run: unknown;
    if (d.actOn) {
      const built = draftToAction(d.act);
      if ("error" in built) {
        setProblem(built.error);
        return undefined;
      }
      run = built.action;
    }
    const baseFire = WatchDefSchema.shape.fire.parse(source?.fire ?? {});
    const parsed = WatchDefSchema.safeParse({
      name: d.name.trim() === "" ? "Untitled watch" : d.name.trim(),
      spec: specOf(d),
      condition: conditionOf(d),
      everyMin: Number(d.everyMin),
      fire: {
        ...baseFire,
        alert: { ...baseFire.alert, on: d.alert },
        run,
        runOverlap: d.actSkip ? "skip" : "allow",
      },
      ...(d.project === "" || d.kind === "path" ? {} : { project: d.project }),
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setProblem(
        issue === undefined
          ? "Check the fields."
          : `${issue.path.slice(-1).join("")}: ${issue.message}`.replace(/^: /, ""),
      );
      return undefined;
    }
    setProblem(undefined);
    return parsed.data;
  };

  const runTest = () => {
    const def = build();
    if (def === undefined) return;
    test.mutate({ org, def }, { onSuccess: setResult, onError: (e) => setProblem(describeError(e)) });
  };
  const submit = () => {
    const def = build();
    if (def === undefined) return;
    save.mutate({ ...(watch === undefined ? {} : { id: watch.id }), org, def } as never, {
      onSuccess: () => {
        toast(watch === undefined ? "Watching it now" : "Saved", { detail: def.name });
        onClose();
      },
      onError: (e) => setProblem(describeError(e)),
    });
  };

  const condNeedsValue = d.ctype === "above" || d.ctype === "below";
  const numeric = d.kind !== "path" && (d.kind !== "price" || d.mode === "value");
  return (
    <Sheet
      title={watch === undefined ? "Set up a watch" : "Edit watch"}
      subtitle="majhi looks on a schedule with cheap checks and tells you when the condition holds"
      onClose={onClose}
      footer={
        <div className="flex items-center justify-end gap-2">
          {problem !== undefined && (
            <span className="mr-auto min-w-0 truncate text-sm text-red">{problem}</span>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={test.isPending} onClick={runTest}>
            Test it
          </Button>
          <Button variant="primary" disabled={save.isPending} onClick={submit}>
            {watch === undefined ? "Start watching" : "Save"}
          </Button>
        </div>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Workspace">
            {(p) => (
              <Select
                {...p}
                value={org}
                disabled={watch !== undefined}
                onChange={(e) => {
                  setOrg(e.target.value);
                  set("connection", "");
                  set("project", "");
                }}
              >
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Name">
            {(p) => (
              <Input
                {...p}
                value={d.name}
                placeholder="Shop API health"
                onChange={(e) => set("name", e.target.value)}
              />
            )}
          </Field>
          <Field label="What to watch">
            {(p) => (
              <Select
                {...p}
                value={d.urlChange ? "urlchange" : d.kind}
                disabled={watch !== undefined}
                onChange={(e) => {
                  const picked = e.target.value;
                  if (picked === "urlchange") {
                    setD({
                      ...emptyDraft("price"),
                      name: d.name,
                      mode: "text",
                      ctype: "changed",
                      urlChange: true,
                      everyMin: "5",
                      alert: false,
                    });
                  } else {
                    const kind = picked as WatchSort;
                    setD({ ...emptyDraft(kind), name: d.name, ...(kind === "path" ? { alert: false } : {}) });
                  }
                  setResult(undefined);
                }}
              >
                {WATCH_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {WATCH_KIND_ONE[k]}
                  </option>
                ))}
                <option value="urlchange">A URL changes</option>
              </Select>
            )}
          </Field>
          <Field label="Look every">
            {(p) => (
              <Select {...p} value={d.everyMin} onChange={(e) => set("everyMin", e.target.value)}>
                {EVERY.some((o) => o.v === d.everyMin) ? null : (
                  <option value={d.everyMin}>{d.everyMin} minutes</option>
                )}
                {EVERY.map((o) => (
                  <option key={o.v} value={o.v}>
                    {o.l}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>

        {d.kind === "path" && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Project" hint="Only its checkout is looked at.">
              {(p) => (
                <Select {...p} value={d.project} onChange={(e) => set("project", e.target.value)}>
                  <option value="">Pick a project</option>
                  {mine.map((pr) => (
                    <option key={pr.id} value={pr.id}>
                      {pr.id}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="File or folder" hint="Relative to the project. A folder counts everything in it.">
              {(p) => (
                <Input
                  {...p}
                  className="font-mono"
                  value={d.path}
                  placeholder="docs/plan.md"
                  onChange={(e) => set("path", e.target.value)}
                />
              )}
            </Field>
          </div>
        )}
        {(d.kind === "website" || d.kind === "price") && (
          <Field
            label="Address"
            hint={
              d.kind === "price"
                ? "A public page. majhi sends no cookies and signs in nowhere."
                : "An http or https address."
            }
          >
            {(p) => (
              <Input
                {...p}
                type="url"
                value={d.url}
                placeholder="https://acme.example/health"
                onChange={(e) => set("url", e.target.value)}
              />
            )}
          </Field>
        )}
        {d.kind === "website" && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Status that counts as up" hint="Empty: below 400">
              {(p) => (
                <Input
                  {...p}
                  inputMode="numeric"
                  value={d.expectStatus}
                  placeholder="200"
                  onChange={(e) => set("expectStatus", e.target.value)}
                />
              )}
            </Field>
            <Field label="Page contains">
              {(p) => <Input {...p} value={d.keyword} onChange={(e) => set("keyword", e.target.value)} />}
            </Field>
            <Field label="Number at JSON path" hint="Like data.queue.depth">
              {(p) => (
                <Input
                  {...p}
                  className="font-mono"
                  value={d.jsonPath}
                  onChange={(e) => set("jsonPath", e.target.value)}
                />
              )}
            </Field>
          </div>
        )}
        {d.kind === "price" && !d.urlChange && (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Watch">
                {(p) => (
                  <Select
                    {...p}
                    value={d.mode}
                    onChange={(e) => set("mode", e.target.value as Draft["mode"])}
                  >
                    <option value="value">A price or number</option>
                    <option value="text">A change of the page's main text</option>
                  </Select>
                )}
              </Field>
              <Field
                label="Where on the page"
                hint="A CSS selector, like .price. Empty: majhi looks for the page's own price"
              >
                {(p) => (
                  <Input
                    {...p}
                    className="font-mono"
                    value={d.selector}
                    onChange={(e) => set("selector", e.target.value)}
                  />
                )}
              </Field>
            </div>
            {d.mode === "value" && (
              <Field label="Or text around the number" hint="Like Price: (\\d+)">
                {(p) => (
                  <Input
                    {...p}
                    className="font-mono"
                    value={d.pattern}
                    onChange={(e) => set("pattern", e.target.value)}
                  />
                )}
              </Field>
            )}
            <Field
              label="Other stores to compare"
              hint="One address per line. The captain looks at them when it fires. It never buys."
            >
              {(p) => (
                <textarea
                  {...p}
                  rows={2}
                  className="min-h-[56px] w-full resize-y rounded-md border border-line bg-field px-2.5 py-1.5 font-mono text-sm text-fg"
                  value={d.compare}
                  onChange={(e) => set("compare", e.target.value)}
                />
              )}
            </Field>
          </>
        )}

        {(d.kind === "database" ||
          d.kind === "redis" ||
          d.kind === "queue" ||
          d.kind === "server" ||
          d.kind === "metric") && (
          <Field
            label="Connection"
            hint={
              choices.length === 0
                ? d.kind === "server"
                  ? "Add an SSH connection in this workspace first."
                  : d.kind === "metric"
                    ? "Add a monitoring MCP connection in this workspace first."
                    : "Add a Variables connection with a DATABASE_URL or REDIS_URL in this workspace first."
                : undefined
            }
          >
            {(p) => (
              <Select {...p} value={d.connection} onChange={(e) => set("connection", e.target.value)}>
                <option value="">Pick one</option>
                {choices.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        {(d.kind === "database" || (d.kind === "queue" && d.source === "sql")) && (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label="Database">
                {(p) => (
                  <Select
                    {...p}
                    value={d.engine}
                    onChange={(e) => set("engine", e.target.value as Draft["engine"])}
                  >
                    <option value="postgres">Postgres</option>
                    <option value="mysql">MySQL</option>
                  </Select>
                )}
              </Field>
              {d.kind === "database" && (
                <>
                  <Field label="Called">
                    {(p) => (
                      <Input
                        {...p}
                        value={d.label}
                        placeholder="p95"
                        onChange={(e) => set("label", e.target.value)}
                      />
                    )}
                  </Field>
                  <Field label="Unit">
                    {(p) => (
                      <Input
                        {...p}
                        value={d.unit}
                        placeholder="s"
                        onChange={(e) => set("unit", e.target.value)}
                      />
                    )}
                  </Field>
                </>
              )}
            </div>
            <Field
              label="Query"
              hint="One SELECT, SHOW or EXPLAIN that returns a number. Anything that writes is refused."
            >
              {(p) => (
                <textarea
                  {...p}
                  rows={3}
                  className="min-h-[72px] w-full resize-y rounded-md border border-line bg-field px-2.5 py-1.5 font-mono text-sm text-fg"
                  value={d.query}
                  placeholder="SELECT count(*) FROM jobs WHERE state = 'waiting'"
                  onChange={(e) => set("query", e.target.value)}
                />
              )}
            </Field>
          </>
        )}
        {d.kind === "redis" && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Watch">
              {(p) => (
                <Select
                  {...p}
                  value={d.redisMetric}
                  onChange={(e) => set("redisMetric", e.target.value as Draft["redisMetric"])}
                >
                  <option value="memory_ratio">Memory used, % of its limit</option>
                  <option value="clients">Connected clients</option>
                  <option value="keys">Number of keys</option>
                  <option value="info">An INFO field</option>
                </Select>
              )}
            </Field>
            {d.redisMetric === "info" && (
              <Field label="INFO field" hint="Like evicted_keys">
                {(p) => (
                  <Input
                    {...p}
                    className="font-mono"
                    value={d.infoField}
                    onChange={(e) => set("infoField", e.target.value)}
                  />
                )}
              </Field>
            )}
          </div>
        )}
        {d.kind === "server" && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Watch" hint="majhi only runs df, uptime and free">
              {(p) => (
                <Select
                  {...p}
                  value={d.serverMetric}
                  onChange={(e) => set("serverMetric", e.target.value as Draft["serverMetric"])}
                >
                  <option value="disk">Disk used, %</option>
                  <option value="cpu">Load average</option>
                  <option value="memory">Memory used, %</option>
                </Select>
              )}
            </Field>
            {d.serverMetric === "disk" && (
              <Field label="Mount">
                {(p) => (
                  <Input
                    {...p}
                    className="font-mono"
                    value={d.path}
                    onChange={(e) => set("path", e.target.value)}
                  />
                )}
              </Field>
            )}
          </div>
        )}
        {d.kind === "queue" && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Count">
              {(p) => (
                <Select
                  {...p}
                  value={d.source}
                  onChange={(e) => set("source", e.target.value as Draft["source"])}
                >
                  <option value="redis_list">A Redis list's length</option>
                  <option value="sql">A database count query</option>
                </Select>
              )}
            </Field>
            {d.source === "redis_list" && (
              <Field label="List name">
                {(p) => (
                  <Input
                    {...p}
                    className="font-mono"
                    value={d.key}
                    placeholder="queue:default"
                    onChange={(e) => set("key", e.target.value)}
                  />
                )}
              </Field>
            )}
          </div>
        )}
        {d.kind === "metric" && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Read tool" hint="A tool that only reads">
              {(p) => (
                <Input
                  {...p}
                  className="font-mono"
                  value={d.tool}
                  placeholder="get_error_rate"
                  onChange={(e) => set("tool", e.target.value)}
                />
              )}
            </Field>
            <Field label="Arguments (JSON)">
              {(p) => (
                <Input
                  {...p}
                  className="font-mono"
                  value={d.args}
                  onChange={(e) => set("args", e.target.value)}
                />
              )}
            </Field>
            <Field label="Number is at" hint="Like data.errorRate">
              {(p) => (
                <Input
                  {...p}
                  className="font-mono"
                  value={d.metricPath}
                  onChange={(e) => set("metricPath", e.target.value)}
                />
              )}
            </Field>
            <Field label="Called">
              {(p) => (
                <Input
                  {...p}
                  value={d.label}
                  placeholder="error rate"
                  onChange={(e) => set("label", e.target.value)}
                />
              )}
            </Field>
          </div>
        )}
        {d.kind === "custom" && (
          <Field
            label="What to check"
            hint="The captain looks on the schedule with a small budget and reports a value or a state."
          >
            {(p) => (
              <textarea
                {...p}
                rows={3}
                className="min-h-[72px] w-full resize-y rounded-md border border-line bg-field px-2.5 py-1.5 text-base text-fg"
                value={d.instruction}
                placeholder="New grants for open-source tools in Bangladesh"
                onChange={(e) => set("instruction", e.target.value)}
              />
            )}
          </Field>
        )}

        <fieldset className="m-0 flex flex-col gap-3 border-0 p-0">
          <legend className="mb-1 p-0 text-sm font-medium text-fg">Alert me when</legend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Condition">
              {(p) => (
                <Select
                  {...p}
                  value={d.ctype}
                  onChange={(e) => set("ctype", e.target.value as Draft["ctype"])}
                >
                  {numeric && <option value="above">It goes above</option>}
                  {numeric && <option value="below">It goes below</option>}
                  <option value="changed">It changes</option>
                  {(d.kind === "price" || d.kind === "custom") && (
                    <option value="contains">It contains text</option>
                  )}
                  {(d.kind === "price" || d.kind === "custom") && (
                    <option value="notContains">It stops containing text</option>
                  )}
                  {(d.kind === "website" || d.kind === "custom") && <option value="down">It is down</option>}
                </Select>
              )}
            </Field>
            {condNeedsValue && (
              <>
                <Field
                  label="Limit"
                  hint={d.kind === "website" && d.jsonPath === "" ? "Milliseconds to first byte" : undefined}
                >
                  {(p) => (
                    <Input
                      {...p}
                      inputMode="decimal"
                      value={d.value}
                      onChange={(e) => set("value", e.target.value)}
                    />
                  )}
                </Field>
                <Field label="For (minutes)" hint="0: at once">
                  {(p) => (
                    <Input
                      {...p}
                      inputMode="numeric"
                      value={d.forMin}
                      onChange={(e) => set("forMin", e.target.value)}
                    />
                  )}
                </Field>
              </>
            )}
            {(d.ctype === "contains" || d.ctype === "notContains") && (
              <Field label="Text">
                {(p) => <Input {...p} value={d.text} onChange={(e) => set("text", e.target.value)} />}
              </Field>
            )}
          </div>
        </fieldset>
        {d.kind !== "path" && (
          <Field label="A fix opens in" hint="The project a fix task goes to">
            {(p) => (
              <Select {...p} value={d.project} onChange={(e) => set("project", e.target.value)}>
                <option value="">No project</option>
                {mine.map((pr) => (
                  <option key={pr.id} value={pr.id}>
                    {pr.id}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <fieldset className="m-0 flex flex-col gap-3 border-0 p-0">
          <legend className="mb-1 p-0 text-sm font-medium text-fg">When it fires</legend>
          <Switch label="Raise an alert (an incident)" checked={d.alert} onChange={(v) => set("alert", v)} />
          <Switch
            label="Run an action: start a task, post in a room or run a process"
            checked={d.actOn}
            onChange={(v) => set("actOn", v)}
          />
          {d.actOn && (
            <>
              <ActionFields org={org} draft={d.act} onChange={(next) => set("act", next)} eventHelp />
              <Switch
                label="Skip if the last run is still going"
                checked={d.actSkip}
                onChange={(v) => set("actSkip", v)}
              />
            </>
          )}
        </fieldset>
        {result !== undefined && (
          <p className={result.ok ? "m-0 text-sm text-lamp-done" : "m-0 text-sm text-red"}>
            {result.ok ? `Right now: ${result.value}` : result.value}
          </p>
        )}
        <p className="m-0 text-sm text-fg-faint">
          Looking into it and fixes are set on the watch after it starts.
        </p>
      </form>
    </Sheet>
  );
}
