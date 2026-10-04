import type {
  ConnectionView,
  McpEntryPreview,
  McpInput,
  McpInstallInput,
  McpInstallResult,
  McpPreview,
  McpSearchResult,
  OrgView,
} from "@majhi/shared";
import { Download, Link2, Plus, Search, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { PageLink } from "@/components/ui/page-link";
import { Segmented } from "@/components/ui/segmented";
import { Select, Textarea } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { orgLabel } from "@/features/accounts/model";
import { WorkspaceTag } from "@/features/connections/scope-picker";
import { SecretInput } from "@/features/connections/value-controls";
import { cn } from "@/lib/cn";
import { useConnectionCommand, useConnections } from "@/lib/connection-queries";
import { describeError } from "@/lib/errors";
import { plural } from "@/lib/format";
import { useMcpSearch, useSkillsCommand } from "@/lib/skills-queries";
import { useAgents, useOrgs } from "@/lib/studio-queries";
import { agentChoices, Block, ErrorLine, NameList, SourceLink } from "./parts";

type Mode = "registry" | "url" | "command" | "json";
type Request = Omit<McpInstallInput, "confirm" | "values">;

interface Review {
  preview: McpPreview;
  request: Request;
}

interface Row {
  name: string;
  value: string;
  secret: boolean;
}

const MODES = [
  { value: "registry", label: "Registry" },
  { value: "url", label: "URL" },
  { value: "command", label: "Command" },
  { value: "json", label: "Pasted JSON" },
] as const;

/** The MCP servers tab: install box, a card to review before anything is created, the registry, and what is installed. */
export function McpTab() {
  const connections = useConnections();
  const _agents = agentChoices(useAgents().data);
  const orgs = useOrgs().data ?? [];
  const [org, setOrg] = useState("");
  const [review, setReview] = useState<Review>();
  const [installed, setInstalled] = useState<Extract<McpInstallResult, { status: "installed" }>>();
  const chosen = org !== "" ? org : orgs.length > 1 ? (orgs[0]?.id ?? "") : "";
  const mcp = (connections.data ?? []).filter((c) => c.type === "mcp");

  const [adding, setAdding] = useState(false);
  const [picked, setPicked] = useState<"installed" | "discover">();
  const view = picked ?? (!connections.isPending && mcp.length === 0 ? "discover" : "installed");
  const show = (next: Review) => {
    setInstalled(undefined);
    setAdding(false);
    setReview(next);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Segmented
          label="MCP servers view"
          value={view}
          onChange={setPicked}
          segments={[
            { value: "installed", label: "Installed", count: mcp.length },
            { value: "discover", label: "Discover" },
          ]}
        />
        {orgs.length > 1 && (
          <span className="flex items-center gap-2 text-sm text-fg-muted">
            Installs go to
            <Select
              aria-label="Workspace new servers go to"
              className="w-[180px]"
              value={chosen}
              onChange={(e) => setOrg(e.target.value)}
            >
              {orgs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </Select>
          </span>
        )}
        <Button className="ml-auto" onClick={() => setAdding(!adding)} aria-expanded={adding}>
          <Link2 aria-hidden="true" />
          Add by URL or command
        </Button>
      </div>
      {adding && <InstallBox orgs={orgs} org={chosen} onOrg={setOrg} onPreview={show} />}
      {review && (
        <PreviewCard
          key={review.preview.previewId}
          review={review}
          orgs={orgs}
          onPreview={(next) => setReview(next)}
          onCancel={() => setReview(undefined)}
          onInstalled={(result) => {
            setReview(undefined);
            setPicked("installed");
            setInstalled(result);
          }}
        />
      )}
      {installed && <JustInstalled result={installed} />}
      {view === "discover" ? (
        <Browse org={chosen} onPreview={show} />
      ) : (
        <InstalledServers
          servers={connections.isPending ? undefined : mcp}
          error={connections.isError ? describeError(connections.error) : undefined}
          orgs={orgs}
          onDiscover={() => setPicked("discover")}
        />
      )}
    </div>
  );
}

function InstallBox({
  orgs,
  org,
  onOrg,
  onPreview,
}: {
  orgs: readonly OrgView[];
  org: string;
  onOrg: (org: string) => void;
  onPreview: (review: Review) => void;
}) {
  const install = useSkillsCommand("mcp.install");
  const [mode, setMode] = useState<Mode>("registry");
  const [registry, setRegistry] = useState("");
  const [url, setUrl] = useState("");
  const [protocol, setProtocol] = useState<"http" | "sse">("http");
  const [command, setCommand] = useState("");
  const [json, setJson] = useState("");
  const [pick, setPick] = useState("");
  const [rows, setRows] = useState<Row[]>([]);

  const entries = (): Pick<Request, "headers" | "env" | "secrets"> => {
    const named = rows.filter((r) => r.name.trim() !== "");
    const values = Object.fromEntries(named.map((r) => [r.name.trim(), r.secret ? "" : r.value]));
    const secrets = named.filter((r) => r.secret).map((r) => r.name.trim());
    return {
      ...(named.length === 0 ? {} : mode === "url" ? { headers: values } : { env: values }),
      ...(secrets.length === 0 ? {} : { secrets }),
    };
  };
  const request = (): Request | undefined => {
    const where = org === "" ? {} : { org };
    switch (mode) {
      case "registry":
        return registry.trim() === "" ? undefined : { registry: registry.trim(), ...where };
      case "url":
        return url.trim() === "" ? undefined : { url: url.trim(), protocol, ...entries(), ...where };
      case "command":
        return command.trim() === "" ? undefined : { command: command.trim(), ...entries(), ...where };
      case "json":
        return json.trim() === ""
          ? undefined
          : { json: json.trim(), ...(pick.trim() === "" ? {} : { pick: pick.trim() }), ...where };
    }
  };
  const ready = request();
  const send = () => {
    if (ready === undefined || install.isPending) return;
    install.mutate(ready, {
      onSuccess: (r) => r.status === "preview" && onPreview({ preview: r, request: ready }),
    });
  };
  const setRow = (i: number, patch: Partial<Row>) =>
    setRows((prev) => prev.map((r, at) => (at === i ? { ...r, ...patch } : r)));

  return (
    <Block
      title="Add an MCP server"
      note="From the registry by name, a remote URL, a local command or a pasted mcpServers snippet. You review it before it is created."
      actions={
        <Segmented
          label="How to install"
          value={mode}
          segments={MODES}
          onChange={(next) => {
            setMode(next);
            setRows([]);
            install.reset();
          }}
        />
      }
    >
      <div className="flex flex-col gap-3">
        {mode === "registry" && (
          <Field label="Registry name" hint="Like io.github.acme/weather. Or search the registry below.">
            {(p) => (
              <Input
                {...p}
                className="h-10 font-mono"
                value={registry}
                onChange={(e) => setRegistry(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && send()}
              />
            )}
          </Field>
        )}
        {mode === "url" && (
          <>
            <div className="flex flex-wrap gap-2.5">
              <Field label="Server address" className="min-w-[280px] flex-1">
                {(p) => (
                  <Input
                    {...p}
                    className="h-10"
                    placeholder="https://mcp.acme.com/mcp"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && send()}
                  />
                )}
              </Field>
              <Field label="Protocol" className="w-[200px]">
                {(p) => (
                  <Select
                    {...p}
                    className="h-10"
                    value={protocol}
                    onChange={(e) => setProtocol(e.target.value === "sse" ? "sse" : "http")}
                  >
                    <option value="http">Streamable HTTP</option>
                    <option value="sse">SSE</option>
                  </Select>
                )}
              </Field>
            </div>
            <Rows
              noun="Header"
              rows={rows}
              onAdd={() => setRows((p) => [...p, { name: "", value: "", secret: false }])}
              onChange={setRow}
              onRemove={(i) => setRows((p) => p.filter((_, at) => at !== i))}
            />
          </>
        )}
        {mode === "command" && (
          <>
            <Field
              label="Command"
              hint="With the package version pinned, like npx -y @acme/mcp-weather@1.2.0 or uvx acme-mcp==1.2.0."
            >
              {(p) => (
                <Input
                  {...p}
                  className="h-10 font-mono"
                  placeholder="npx -y @acme/mcp-weather@1.2.0"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && send()}
                />
              )}
            </Field>
            <Rows
              noun="Variable"
              rows={rows}
              onAdd={() => setRows((p) => [...p, { name: "", value: "", secret: false }])}
              onChange={setRow}
              onRemove={(i) => setRows((p) => p.filter((_, at) => at !== i))}
            />
          </>
        )}
        {mode === "json" && (
          <>
            <Field
              label="Snippet"
              hint="The mcpServers or .mcp.json shape. Secret values are not kept: set them after installing."
            >
              {(p) => (
                <Textarea
                  {...p}
                  rows={6}
                  placeholder={
                    '{ "mcpServers": { "weather": { "command": "npx", "args": ["-y", "@acme/mcp-weather@1.2.0"] } } }'
                  }
                  value={json}
                  onChange={(e) => setJson(e.target.value)}
                />
              )}
            </Field>
            <Field
              label="Server to use"
              hint="Only when the snippet holds more than one."
              className="max-w-[320px]"
            >
              {(p) => <Input {...p} value={pick} onChange={(e) => setPick(e.target.value)} />}
            </Field>
          </>
        )}
        <div className="flex flex-wrap items-end gap-2.5">
          {orgs.length > 1 && <OrgSelect orgs={orgs} value={org} onChange={onOrg} />}
          <Button
            variant="primary"
            size="lg"
            disabled={ready === undefined || install.isPending}
            onClick={send}
          >
            {install.isPending ? "Looking it up" : "Review"}
          </Button>
        </div>
        {install.isError && <ErrorLine>{describeError(install.error)}</ErrorLine>}
      </div>
    </Block>
  );
}

function OrgSelect({
  orgs,
  value,
  onChange,
}: {
  orgs: readonly OrgView[];
  value: string;
  onChange: (org: string) => void;
}) {
  return (
    <Field label="Org that gets the server" className="w-[220px]">
      {(p) => (
        <Select {...p} className="h-10" value={value} onChange={(e) => onChange(e.target.value)}>
          {orgs.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}

/** Header or variable rows: a name, a value, and a Secret box. A secret has no value here: it is set after installing. */
function Rows({
  noun,
  rows,
  onAdd,
  onChange,
  onRemove,
}: {
  noun: string;
  rows: readonly Row[];
  onAdd: () => void;
  onChange: (index: number, patch: Partial<Row>) => void;
  onRemove: (index: number) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      {rows.map((row, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id, and are only added and removed by position
        <div key={i} className="flex flex-wrap items-center gap-2">
          <Input
            aria-label={`${noun} ${i + 1} name`}
            className="w-[200px] font-mono"
            placeholder="Name"
            value={row.name}
            onChange={(e) => onChange(i, { name: e.target.value })}
          />
          <Input
            aria-label={`${noun} ${i + 1} value`}
            className="min-w-[180px] flex-1 font-mono"
            placeholder={row.secret ? "Set after installing" : "Value"}
            disabled={row.secret}
            value={row.secret ? "" : row.value}
            onChange={(e) => onChange(i, { value: e.target.value })}
          />
          <label className="flex items-center gap-1.5 text-sm text-fg-soft">
            <input
              type="checkbox"
              checked={row.secret}
              onChange={(e) => onChange(i, { secret: e.target.checked })}
            />
            Secret
          </label>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Remove ${noun.toLowerCase()} ${i + 1}`}
            onClick={() => onRemove(i)}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
      ))}
      <Button size="sm" className="self-start" onClick={onAdd}>
        <Plus aria-hidden="true" />
        Add {noun.toLowerCase()}
      </Button>
    </div>
  );
}

function transportLine(p: McpPreview): string {
  if (p.transport === "local") return "Local command, started in the agent's runner";
  return p.protocol === "sse" ? "Remote server over SSE" : "Remote server over Streamable HTTP";
}

function EntryList({ title, entries }: { title: string; entries: readonly McpEntryPreview[] }) {
  if (entries.length === 0) return null;
  return (
    <ul aria-label={title} className="flex flex-col gap-1">
      {entries.map((e) => (
        <li key={e.name} className="flex flex-wrap items-center gap-2 text-base">
          <span className="font-mono text-fg">{e.name}</span>
          {e.kind === "secret" ? (
            <Badge tone="amber">Secret, set after installing</Badge>
          ) : (
            <Badge>Text</Badge>
          )}
          {e.required && <Badge>Required</Badge>}
          {e.kind === "text" && e.value !== undefined && (
            <span className="font-mono text-fg-soft break-all">{e.value}</span>
          )}
          {e.description && <span className="text-sm text-fg-faint">{e.description}</span>}
        </li>
      ))}
    </ul>
  );
}

/** What the server is and what it runs, before a connection is created. */
function PreviewCard({
  review,
  orgs,
  onPreview,
  onCancel,
  onInstalled,
}: {
  review: Review;
  orgs: readonly OrgView[];
  onPreview: (review: Review) => void;
  onCancel: () => void;
  onInstalled: (result: Extract<McpInstallResult, { status: "installed" }>) => void;
}) {
  const { preview, request } = review;
  const install = useSkillsCommand("mcp.install");
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(preview.inputs.map((i) => [i.name, i.value ?? ""])),
  );
  const [error, setError] = useState<string>();
  const changed = preview.inputs.some((i) => (values[i.name] ?? "") !== (i.value ?? ""));
  const missing = preview.inputs.filter((i) => i.required && (values[i.name] ?? "").trim() === "");
  const withValues = (): Request & { values?: Record<string, string> } => ({
    ...request,
    ...(preview.inputs.length === 0 ? {} : { values }),
  });

  /** Installs: first, if the owner filled in values, a fresh preview that holds them, then the confirm. */
  const commit = async () => {
    setError(undefined);
    try {
      let current = preview;
      if (changed) {
        const next = await install.mutateAsync(withValues());
        if (next.status !== "preview") return;
        current = next;
        onPreview({ preview: next, request: withValues() });
        if (next.inputs.some((i) => i.required && (i.value ?? "") === "")) return;
      }
      const done = await install.mutateAsync({ confirm: current.previewId });
      if (done.status === "installed") onInstalled(done);
    } catch (e) {
      setError(describeError(e));
    }
  };
  const changeOrg = async (next: string) => {
    setError(undefined);
    try {
      const again = await install.mutateAsync({ ...withValues(), org: next });
      if (again.status === "preview") onPreview({ preview: again, request: { ...request, org: next } });
    } catch (e) {
      setError(describeError(e));
    }
  };
  const { source } = preview;

  return (
    <Block
      title="Review before installing"
      note="An MCP server runs code or reaches a service for the agents you turn it on for. Only install ones you trust."
      actions={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={install.isPending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={commit} disabled={install.isPending || missing.length > 0}>
            <Download aria-hidden="true" />
            {install.isPending ? "Working" : "Install"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-1">
        <span className="text-md font-semibold text-fg">{preview.name}</span>
        {preview.description && <p className="text-base text-fg-muted text-pretty">{preview.description}</p>}
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-base">
        {source.publisher && (
          <>
            <dt className="text-fg-faint">Publisher</dt>
            <dd className="font-mono text-fg-soft">{source.publisher}</dd>
          </>
        )}
        {(source.repository ?? source.websiteUrl) && (
          <>
            <dt className="text-fg-faint">Source</dt>
            <dd className="min-w-0">
              <SourceLink source={(source.repository ?? source.websiteUrl) as string} />
            </dd>
          </>
        )}
        {source.registry && (
          <>
            <dt className="text-fg-faint">Registry</dt>
            <dd className="font-mono text-fg-soft">
              {source.registry.name}@{source.registry.version}
            </dd>
          </>
        )}
        <dt className="text-fg-faint">Transport</dt>
        <dd className="text-fg-soft">{transportLine(preview)}</dd>
        {preview.url && (
          <>
            <dt className="text-fg-faint">Address</dt>
            <dd className="font-mono text-fg-soft break-all">{preview.url}</dd>
          </>
        )}
        {preview.command && (
          <>
            <dt className="text-fg-faint">Command</dt>
            <dd className="font-mono text-fg-soft break-all">{preview.command}</dd>
          </>
        )}
        {source.package && (
          <>
            <dt className="text-fg-faint">Package</dt>
            <dd className="font-mono text-fg-soft">
              {source.package.registryType}: {source.package.identifier}@{source.package.version}
            </dd>
          </>
        )}
        <dt className="text-fg-faint">Connection</dt>
        <dd className="font-mono text-fg-soft">{preview.id}</dd>
      </dl>
      {orgs.length > 1 ? (
        <OrgSelect orgs={orgs} value={preview.org} onChange={(next) => void changeOrg(next)} />
      ) : (
        <p className="text-sm text-fg-faint">Goes to {orgLabel(preview.org, orgs).name}.</p>
      )}
      <EntryList title="Headers" entries={preview.headers} />
      <EntryList title="Variables" entries={preview.env} />
      {preview.inputs.length > 0 && (
        <div className="grid gap-3 @[560px]:grid-cols-2">
          {preview.inputs.map((input) => (
            <InputField
              key={input.name}
              input={input}
              value={values[input.name] ?? ""}
              onChange={(v) => setValues((p) => ({ ...p, [input.name]: v }))}
            />
          ))}
        </div>
      )}
      {preview.warnings.length > 0 && (
        <ul
          aria-label="Warnings"
          className="flex flex-col gap-1 rounded-lg border border-amber-line bg-amber-wash px-3 py-2"
        >
          {preview.warnings.map((w) => (
            <li key={w} className="text-base text-amber text-pretty">
              {w}
            </li>
          ))}
        </ul>
      )}
      {missing.length > 0 && (
        <p className="text-sm text-fg-faint">Fill in {missing.map((m) => m.name).join(", ")} to install.</p>
      )}
      {error && <ErrorLine>{error}</ErrorLine>}
    </Block>
  );
}

function InputField({
  input,
  value,
  onChange,
}: {
  input: McpInput;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field label={`${input.name}${input.required ? " (required)" : ""}`} hint={input.description}>
      {(p) =>
        input.choices && input.choices.length > 0 ? (
          <Select {...p} value={value} onChange={(e) => onChange(e.target.value)}>
            <option value="">Choose</option>
            {input.choices.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
        ) : (
          <Input {...p} className="font-mono" value={value} onChange={(e) => onChange(e.target.value)} />
        )
      }
    </Field>
  );
}

/**
 * After the connection is created: its secrets as write-only inputs, then Test with the whole tool
 * list. Test runs by itself once the last required secret is set.
 */
function JustInstalled({ result }: { result: Extract<McpInstallResult, { status: "installed" }> }) {
  const connections = useConnections();
  const test = useConnectionCommand("connections.test");
  const live = connections.data?.find((c) => c.id === result.connection.id) ?? result.connection;
  const unset = result.needs.filter((n) => n.required && live[n.list][n.name]?.set !== true);
  const outcome = live.lastTest ?? result.test;
  const ready = unset.length === 0;
  useEffect(() => {
    if (ready && outcome === undefined && !test.isPending && !test.isError) test.mutate({ id: live.id });
  }, [ready, outcome, test, live.id]);

  return (
    <Block
      title={`${live.name} installed`}
      note="It is not turned on for any agent yet. Turn it on in the list below."
      actions={
        <Button size="sm" disabled={!ready || test.isPending} onClick={() => test.mutate({ id: live.id })}>
          {test.isPending ? "Testing" : "Test again"}
        </Button>
      }
    >
      {result.needs.length > 0 && (
        <div className="flex flex-col gap-3">
          <p className="text-base text-fg-muted text-pretty">
            It needs {plural(result.needs.length, "secret")}. Type each value here: it goes to secrets.age and
            is never shown again.
          </p>
          {result.needs.map((need) => (
            <Field
              key={`${need.list}:${need.name}`}
              label={`${need.name}${need.required ? "" : " (optional)"}`}
              hint={need.description}
            >
              {(p) => (
                <SecretInput
                  id={live.id}
                  field={need.name}
                  list={need.list}
                  label={need.name}
                  value={live[need.list][need.name]}
                  inputId={p.id}
                  describedBy={p["aria-describedby"]}
                />
              )}
            </Field>
          ))}
        </div>
      )}
      {test.isError && <ErrorLine>{describeError(test.error)}</ErrorLine>}
      {outcome && <TestResult outcome={outcome} />}
      {!outcome && !ready && <p className="text-sm text-fg-faint">Test runs when the secrets are set.</p>}
    </Block>
  );
}

function TestResult({ outcome }: { outcome: NonNullable<ConnectionView["lastTest"]> }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="flex flex-wrap items-center gap-2 text-base">
        <Badge tone={outcome.ok ? "green" : "red"}>{outcome.ok ? "Test passed" : "Test failed"}</Badge>
        <span className="text-fg-muted text-pretty">{outcome.detail}</span>
      </p>
      {outcome.warnings.map((w) => (
        <p key={w} className="text-sm text-amber text-pretty">
          {w}
        </p>
      ))}
      {outcome.tools && outcome.tools.length > 0 && (
        <>
          <span className="text-sm text-fg-faint">{plural(outcome.tools.length, "tool")}</span>
          <NameList label="Tools" names={outcome.tools} />
        </>
      )}
    </div>
  );
}

function Browse({ org, onPreview }: { org: string; onPreview: (review: Review) => void }) {
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const search = useMcpSearch(query);
  const install = useSkillsCommand("mcp.install");
  const [from, setFrom] = useState<string>();
  const pick = (r: McpSearchResult) => {
    const request: Request = { registry: r.install.registry, ...(org === "" ? {} : { org }) };
    setFrom(r.name);
    install.mutate(request, {
      onSuccess: (p) => p.status === "preview" && onPreview({ preview: p, request }),
    });
  };
  return (
    <Block
      title="Discover"
      note="Search the official MCP Registry. Each result names its publisher and source repo: read them before you install."
    >
      <form
        className="flex gap-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(text);
        }}
      >
        <label htmlFor="mcp-search" className="sr-only">
          Search MCP servers
        </label>
        <Input
          id="mcp-search"
          className="h-10 flex-1"
          placeholder="Search servers, like github or postgres"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <Button type="submit" size="lg" disabled={text.trim().length < 2}>
          <Search aria-hidden="true" />
          Search
        </Button>
      </form>
      {search.isError && <ErrorLine>{describeError(search.error)}</ErrorLine>}
      {install.isError && <ErrorLine>{describeError(install.error)}</ErrorLine>}
      {search.isFetching && <Skeleton className="h-12 rounded-md" aria-busy="true" />}
      {search.data && !search.isFetching && (
        <>
          {search.data.length === 0 && <p className="text-base text-fg-faint">Nothing found for {query}.</p>}
          <ul aria-label="Search results" className="flex flex-col divide-y divide-line-strong">
            {search.data.map((r) => (
              <li key={`${r.name}@${r.version}`} className="flex items-start gap-3 py-2.5">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="text-base text-fg">
                    {r.title ?? r.name} <span className="font-mono text-sm text-fg-faint">{r.name}</span>
                  </span>
                  <span className="text-sm text-fg-muted text-pretty">{r.description}</span>
                  <span className="flex flex-wrap items-center gap-1.5 text-sm text-fg-faint">
                    <span>by {r.publisher}</span>
                    {r.repository && (
                      <>
                        <span>·</span>
                        <SourceLink source={r.repository} />
                      </>
                    )}
                    {[...r.transports, ...r.packages].map((t) => (
                      <Badge key={t} mono>
                        {t}
                      </Badge>
                    ))}
                  </span>
                </div>
                <Button size="sm" disabled={install.isPending} onClick={() => pick(r)}>
                  {install.isPending && from === r.name ? "Fetching" : "Review"}
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Block>
  );
}

function InstalledServers({
  servers,
  error,
  orgs,
  onDiscover,
}: {
  servers: readonly ConnectionView[] | undefined;
  error: string | undefined;
  orgs: readonly OrgView[];
  onDiscover: () => void;
}) {
  const test = useConnectionCommand("connections.test");
  const toast = useToast();
  const [testing, setTesting] = useState<string>();
  const runTest = (server: ConnectionView) => {
    setTesting(server.id);
    test.mutate(
      { id: server.id },
      {
        onError: (e) => toast(`Could not test ${server.name}`, { detail: describeError(e), tone: "error" }),
        onSettled: () => setTesting(undefined),
      },
    );
  };

  return (
    <Block
      title={servers === undefined ? "Installed" : plural(servers.length, "MCP server")}
      note="Every agent of a server's workspace gets it. Open one to switch it off for an agent."
    >
      {error && <ErrorLine>Could not load MCP servers: {error}</ErrorLine>}
      {servers === undefined && !error && <Skeleton className="h-16 rounded-md" aria-busy="true" />}
      {servers?.length === 0 && (
        <div className="flex flex-col items-start gap-2 py-2">
          <p className="text-base text-fg-muted">No MCP servers yet.</p>
          <Button variant="primary" onClick={onDiscover}>
            <Search aria-hidden="true" />
            Discover MCP servers
          </Button>
        </div>
      )}
      <ul aria-label="Installed MCP servers" className="flex flex-col divide-y divide-line">
        {servers?.map((server) => {
          const tools = server.lastTest?.tools?.length;
          return (
            <li
              key={server.id}
              className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3 first:pt-0 last:pb-0"
            >
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <PageLink
                  page="connections"
                  search={{ connection: server.id }}
                  className="truncate text-base font-semibold text-fg underline-offset-2 hover:underline"
                >
                  {server.name}
                </PageLink>
                <span className="truncate text-sm text-fg-muted">
                  {server.description ||
                    server.fields.url?.value ||
                    server.fields.command?.value ||
                    server.id}
                </span>
              </div>
              <WorkspaceTag org={server.org} orgs={orgs} className="text-sm text-fg-muted" />
              <span className="w-[90px] text-sm text-fg-muted">{plural(server.agents.length, "agent")}</span>
              <span
                className={cn(
                  "w-[110px] text-sm",
                  server.problems.length > 0 || server.lastTest?.ok === false
                    ? "text-red"
                    : server.lastTest
                      ? "text-fg-muted"
                      : "text-amber",
                )}
              >
                {server.problems.length > 0
                  ? "Not set up"
                  : server.lastTest === undefined
                    ? "Not tested"
                    : server.lastTest.ok
                      ? tools === undefined
                        ? "Works"
                        : plural(tools, "tool")
                      : "Test failed"}
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={testing !== undefined}
                onClick={() => runTest(server)}
                aria-label={`Test ${server.name}`}
              >
                {testing === server.id ? "Testing" : "Test"}
              </Button>
            </li>
          );
        })}
      </ul>
    </Block>
  );
}
