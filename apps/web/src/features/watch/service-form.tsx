import { OPS_IMPACT_LABEL, type OpsImpact, type OpsServiceView, PRIVATE } from "@majhi/shared";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Sheet } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { useConnections } from "@/lib/connection-queries";
import { describeError } from "@/lib/errors";
import { useOrgs } from "@/lib/studio-queries";
import { useProjects } from "@/lib/task-queries";
import { useSaveService } from "@/lib/watch-queries";

const IMPACTS: readonly OpsImpact[] = ["high", "medium", "low"];

function numberOrUndefined(text: string): number | undefined {
  const n = Number(text.trim());
  return text.trim() !== "" && Number.isFinite(n) ? n : undefined;
}

/**
 * Add or change one watched service: where it is, what counts as up, how bad an outage is and where a fix
 * goes. The optional monitor reads one number from a monitoring service through one of the workspace's
 * connections: when the connection is gone the address check keeps working.
 */
export function ServiceForm({
  service,
  org: initialOrg,
  onClose,
}: {
  service?: OpsServiceView;
  org: string;
  onClose: () => void;
}) {
  const def = service?.def;
  const orgs = useOrgs().data ?? [];
  const projects = useProjects().data ?? [];
  const connections = useConnections().data ?? [];
  const save = useSaveService();
  const toast = useToast();
  const [org, setOrg] = useState(service?.org ?? initialOrg);
  const [name, setName] = useState(def?.name ?? "");
  const [url, setUrl] = useState(def?.url ?? "");
  const [status, setStatus] = useState(def?.expectStatus === undefined ? "" : String(def.expectStatus));
  const [keyword, setKeyword] = useState(def?.keyword ?? "");
  const [slow, setSlow] = useState(def?.maxLatencyMs === undefined ? "" : String(def.maxLatencyMs));
  const [tls, setTls] = useState(def?.tls ?? url.startsWith("https"));
  const [dns, setDns] = useState(def?.dns ?? false);
  const [impact, setImpact] = useState<OpsImpact>(def?.impact ?? "high");
  const [project, setProject] = useState(def?.project ?? "");
  const [watch, setWatch] = useState(def?.monitor !== undefined);
  const [connection, setConnection] = useState(def?.monitor?.connection ?? "");
  const [tool, setTool] = useState(def?.monitor?.tool ?? "");
  const [args, setArgs] = useState(def?.monitor?.args ?? "{}");
  const [path, setPath] = useState(def?.monitor?.path ?? "");
  const [max, setMax] = useState(def?.monitor === undefined ? "" : String(def.monitor.max));
  const [label, setLabel] = useState(def?.monitor?.label ?? "error rate");
  const workspaces = [{ id: PRIVATE, name: "Private" }, ...orgs.filter((o) => o.id !== PRIVATE)];
  const mine = projects.filter((p) => p.org === org);
  const mcp = connections.filter((c) => c.org === org && c.type === "mcp");
  const monitorReady =
    !watch ||
    (connection !== "" && tool.trim() !== "" && path.trim() !== "" && numberOrUndefined(max) !== undefined);
  const ready = name.trim() !== "" && url.trim() !== "" && monitorReady;

  const submit = () =>
    save.mutate(
      {
        ...(service === undefined ? {} : { id: service.id }),
        org,
        name: name.trim(),
        url: url.trim(),
        ...(numberOrUndefined(status) === undefined ? {} : { expectStatus: numberOrUndefined(status) }),
        ...(keyword === "" ? {} : { keyword }),
        ...(numberOrUndefined(slow) === undefined ? {} : { maxLatencyMs: numberOrUndefined(slow) }),
        tls,
        dns,
        impact,
        ...(project === "" ? {} : { project }),
        ...(watch && numberOrUndefined(max) !== undefined
          ? {
              monitor: {
                connection,
                tool: tool.trim(),
                args,
                path: path.trim(),
                max: numberOrUndefined(max) as number,
                label: label.trim() || "value",
              },
            }
          : {}),
      },
      {
        onSuccess: () => {
          toast(service === undefined ? "Watching it now" : "Saved", { detail: name.trim() });
          onClose();
        },
        onError: (e) => toast("Could not save it", { detail: describeError(e), tone: "error" }),
      },
    );

  return (
    <Sheet
      title={service === undefined ? "Watch a service" : "Edit service"}
      subtitle="majhi looks every 5 minutes and tells you when it stays down"
      onClose={onClose}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!ready || save.isPending} onClick={submit}>
            {service === undefined ? "Start watching" : "Save"}
          </Button>
        </div>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) submit();
        }}
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Workspace">
            {(p) => (
              <Select
                {...p}
                value={org}
                disabled={service !== undefined}
                onChange={(e) => {
                  setOrg(e.target.value);
                  setProject("");
                  setConnection("");
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
              <Input {...p} value={name} placeholder="Acme API" onChange={(e) => setName(e.target.value)} />
            )}
          </Field>
        </div>
        <Field
          label="Address"
          hint="An http or https address, like https://acme.example/health. No sign-in inside it."
        >
          {(p) => (
            <Input
              {...p}
              type="url"
              value={url}
              placeholder="https://acme.example/health"
              onChange={(e) => {
                setUrl(e.target.value);
                if (service === undefined) setTls(e.target.value.startsWith("https"));
              }}
            />
          )}
        </Field>
        <fieldset className="m-0 flex flex-col gap-3 border-0 p-0">
          <legend className="mb-1 p-0 text-sm font-medium text-fg">What counts as up</legend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Status" hint="Empty: anything below 400">
              {(p) => (
                <Input
                  {...p}
                  inputMode="numeric"
                  value={status}
                  placeholder="200"
                  onChange={(e) => setStatus(e.target.value)}
                />
              )}
            </Field>
            <Field label="Page contains" hint="Only whether it is there is kept">
              {(p) => (
                <Input {...p} value={keyword} placeholder="ok" onChange={(e) => setKeyword(e.target.value)} />
              )}
            </Field>
            <Field label="Slower than (ms)" hint="Empty: no limit">
              {(p) => (
                <Input
                  {...p}
                  inputMode="numeric"
                  value={slow}
                  placeholder="2000"
                  onChange={(e) => setSlow(e.target.value)}
                />
              )}
            </Field>
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-1">
            <Switch label="Certificate expiry (daily)" checked={tls} onChange={setTls} />
            <Switch label="Name lookup (daily)" checked={dns} onChange={setDns} />
          </div>
        </fieldset>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field
            label="When it is down"
            hint="Sets how loud the alert is. Only a high incident alerts your phone."
          >
            {(p) => (
              <Select {...p} value={impact} onChange={(e) => setImpact(e.target.value as OpsImpact)}>
                {IMPACTS.map((i) => (
                  <option key={i} value={i}>
                    {i === "high" ? "High" : i === "medium" ? "Medium" : "Low"}:{" "}
                    {OPS_IMPACT_LABEL[i].toLowerCase()}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="A fix opens in" hint="The project the captain proposes a fix task in">
            {(p) => (
              <Select {...p} value={project} onChange={(e) => setProject(e.target.value)}>
                <option value="">No project</option>
                {mine.map((pr) => (
                  <option key={pr.id} value={pr.id}>
                    {pr.id}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <div className="flex flex-col gap-3 border-t border-line pt-3">
          <Switch
            label="Also read a monitoring service"
            checked={watch}
            onChange={setWatch}
            disabled={mcp.length === 0 && !watch}
            title={mcp.length === 0 ? "Connect a monitoring service in this workspace first" : undefined}
          />
          {mcp.length === 0 && !watch && (
            <p className="m-0 text-sm text-fg-faint text-pretty">
              Connect Sentry, Better Stack, Grafana or Datadog as an MCP connection in this workspace to read
              an error rate. Without it the address check still works.
            </p>
          )}
          {watch && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Connection">
                {(p) => (
                  <Select {...p} value={connection} onChange={(e) => setConnection(e.target.value)}>
                    <option value="">Pick one</option>
                    {mcp.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Read tool" hint="A tool that only reads">
                {(p) => (
                  <Input
                    {...p}
                    className="font-mono"
                    value={tool}
                    placeholder="get_error_rate"
                    onChange={(e) => setTool(e.target.value)}
                  />
                )}
              </Field>
              <Field label="Arguments (JSON)">
                {(p) => (
                  <Input
                    {...p}
                    className="font-mono"
                    value={args}
                    onChange={(e) => setArgs(e.target.value)}
                  />
                )}
              </Field>
              <Field label="Number is at" hint="Like data.errorRate">
                {(p) => (
                  <Input
                    {...p}
                    className="font-mono"
                    value={path}
                    placeholder="data.errorRate"
                    onChange={(e) => setPath(e.target.value)}
                  />
                )}
              </Field>
              <Field label="Failing above">
                {(p) => (
                  <Input
                    {...p}
                    inputMode="decimal"
                    value={max}
                    placeholder="5"
                    onChange={(e) => setMax(e.target.value)}
                  />
                )}
              </Field>
              <Field label="Called">
                {(p) => <Input {...p} value={label} onChange={(e) => setLabel(e.target.value)} />}
              </Field>
            </div>
          )}
        </div>
      </form>
    </Sheet>
  );
}
