import { ContainersPatchSchema, type ContainersSettings, ImageRefSchema, sameImage } from "@majhi/shared";
import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { DetailSection } from "@/components/ui/list-detail";
import { SaveSection, type SaveState } from "@/components/ui/save-section";
import { useToast } from "@/components/ui/toast";
import { TaskRef } from "@/features/task-drawer/task-ref";
import { useSaveSettings, useSettings } from "@/lib/boss-queries";
import { useAllowImage, useContainers, useStopContainer } from "@/lib/container-queries";
import { describeError } from "@/lib/errors";
import { formatAgo } from "@/lib/format";
import { useNow } from "@/lib/use-now";

const IDLE: SaveState = { kind: "idle" };

/**
 * Previews and test services majhi runs for agents (PRV-53): what runs now across tasks, the images
 * agents may start, and the limits. Live through the `containers` event.
 */
export function ContainersSection() {
  const settings = useSettings();
  return (
    <>
      <RunningList />
      {settings.isPending && <p className="pt-5 text-sm text-fg-faint">Loading</p>}
      {settings.isError && <p className="pt-5 text-sm text-red">{describeError(settings.error)}</p>}
      {settings.data && (
        <>
          <ImagesList
            images={settings.data.containers.images}
            orgImages={settings.data.containers.org_images}
          />
          <LimitsForm saved={settings.data.containers} />
        </>
      )}
    </>
  );
}

function RunningList() {
  const containers = useContainers();
  const stop = useStopContainer();
  const toast = useToast();
  const now = useNow(60_000);
  const running = (containers.data?.containers ?? []).filter((c) => c.status === "running");
  return (
    <DetailSection
      title="Running now"
      note={containers.data?.available ? `${running.length} across tasks` : undefined}
      className="border-t-0"
    >
      {containers.isPending && <p className="text-sm text-fg-faint">Loading</p>}
      {containers.isError && <p className="text-sm text-red">{describeError(containers.error)}</p>}
      {containers.data && !containers.data.available && (
        <p className="text-sm text-fg-muted text-pretty">
          Containers are off. {containers.data.reason ?? "Containers need majhi running in Docker."}
        </p>
      )}
      {containers.data?.available && running.length === 0 && (
        <p className="text-sm text-fg-faint text-pretty">
          Nothing is running. An agent starts a preview or a service when it needs one.
        </p>
      )}
      {running.length > 0 && (
        <ul aria-label="Running containers" className="m-0 flex max-w-[860px] list-none flex-col p-0">
          {running.map((c) => (
            <li
              key={`${c.task} ${c.process}`}
              className="flex min-h-11 items-center gap-3 border-t border-line py-2 first:border-t-0"
            >
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-base">
                  <TaskRef id={c.task} />
                  <Badge tone={c.kind === "preview" ? "blue" : "neutral"}>{c.kind}</Badge>
                  <span className="font-mono">{c.name}</span>
                  <span className="truncate font-mono text-sm text-fg-muted" title={c.image}>
                    {c.image}
                  </span>
                </span>
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-fg-faint">
                  {c.url && (
                    <span className="font-mono" title="Where the task's runners reach it">
                      {c.url}
                    </span>
                  )}
                  {c.hostUrl && (
                    <a
                      className="inline-flex items-center gap-1 text-blue hover:underline"
                      href={c.hostUrl}
                      target="_blank"
                      rel="noreferrer"
                      title="Open the preview on this computer"
                    >
                      Open {c.hostUrl}
                      <ExternalLink aria-hidden="true" className="size-3" />
                    </a>
                  )}
                  <span>
                    @{c.agent}, started {formatAgo(c.startedAt, now)}
                  </span>
                </span>
              </div>
              <Button
                size="sm"
                variant="secondary"
                disabled={stop.isPending}
                aria-label={`Stop ${c.name} of ${c.task}`}
                onClick={() =>
                  stop.mutate(
                    { task: c.task, name: c.name },
                    {
                      onError: (error) =>
                        toast("Could not stop", { detail: describeError(error), tone: "error" }),
                    },
                  )
                }
              >
                Stop
              </Button>
            </li>
          ))}
        </ul>
      )}
    </DetailSection>
  );
}

function ImagesList({
  images,
  orgImages,
}: {
  images: readonly string[];
  orgImages: Readonly<Record<string, readonly string[]>>;
}) {
  const toast = useToast();
  const change = useAllowImage();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string>();
  const rows: { image: string; org?: string }[] = [
    ...images.map((image) => ({ image })),
    ...Object.entries(orgImages).flatMap(([org, list]) => list.map((image) => ({ image, org }))),
  ];

  function add() {
    const parsed = ImageRefSchema.safeParse(draft);
    if (!parsed.success)
      return setError(parsed.error.issues[0]?.message ?? "Use an image like redis:7-alpine");
    if (images.some((i) => sameImage(i, parsed.data))) return setError("That image is allowed already");
    setError(undefined);
    change.mutate(
      { image: parsed.data, allow: true },
      {
        onSuccess: () => {
          setDraft("");
          toast("Image allowed");
        },
        onError: (e) => setError(describeError(e)),
      },
    );
  }

  return (
    <DetailSection
      title="Allowed images"
      note="Agents may start services only from these. A new one asks you first."
    >
      {rows.length === 0 ? (
        <p className="text-sm text-fg-faint">No images yet.</p>
      ) : (
        <ul aria-label="Allowed images" className="-mx-1.5 flex max-w-[640px] flex-col">
          {rows.map(({ image, org }) => (
            <li
              key={`${org ?? ""} ${image}`}
              className="flex min-h-8 min-w-0 items-center gap-2 px-1.5 text-sm"
            >
              <span className="min-w-0 flex-1 truncate font-mono">{image}</span>
              {org !== undefined && <Badge tone="neutral">{org}</Badge>}
              <Button
                size="sm"
                variant="ghost"
                disabled={change.isPending}
                aria-label={`Remove ${image}${org === undefined ? "" : ` from ${org}`}`}
                onClick={() =>
                  change.mutate(
                    { image, allow: false, ...(org === undefined ? {} : { org }) },
                    {
                      onSuccess: () => toast("Image removed", { detail: "Running containers keep running." }),
                      onError: (e) => toast("Could not remove", { detail: describeError(e), tone: "error" }),
                    },
                  )
                }
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form
        aria-label="Allow an image"
        noValidate
        className="flex max-w-[640px] items-start gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <Field label="Allow an image" error={error} hint="Like postgres:16-alpine" className="flex-1">
          {(p) => (
            <Input
              {...p}
              className="font-mono"
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setError(undefined);
              }}
            />
          )}
        </Field>
        <Button type="submit" className="mt-[26px]" disabled={change.isPending || draft.trim() === ""}>
          Allow
        </Button>
      </form>
    </DetailSection>
  );
}

type LimitKey = Exclude<keyof ContainersSettings, "images" | "org_images">;
const LIMITS: readonly { key: LimitKey; label: string; hint: string }[] = [
  { key: "cpus", label: "CPUs per container", hint: "0.25 to 16" },
  { key: "memory", label: "Memory per container", hint: "Like 512m or 2g" },
  { key: "per_task", label: "Containers per task", hint: "Previews and services at once, 1 to 10" },
  { key: "total", label: "Containers across all tasks", hint: "Previews and services at once, 1 to 100" },
  { key: "build_total", label: "Concurrent preview builds", hint: "Across all tasks, 1 to 10" },
  { key: "build_cpus", label: "CPUs for a preview build", hint: "0.25 to 16" },
  { key: "build_memory", label: "Memory for a preview build", hint: "Like 4g" },
];

function LimitsForm({ saved }: { saved: ContainersSettings }) {
  const save = useSaveSettings();
  const [edits, setEdits] = useState<Partial<Record<LimitKey, string>>>({});
  const [state, setState] = useState<SaveState>(IDLE);
  const [showErrors, setShowErrors] = useState(false);
  const value = (key: LimitKey) => edits[key] ?? String(saved[key]);
  const dirty = LIMITS.some(({ key }) => value(key) !== String(saved[key]));
  const parsed = ContainersPatchSchema.safeParse({
    cpus: Number(value("cpus")),
    memory: value("memory").trim(),
    per_task: Number(value("per_task")),
    total: Number(value("total")),
    build_total: Number(value("build_total")),
    build_cpus: Number(value("build_cpus")),
    build_memory: value("build_memory").trim(),
  });
  const problems = new Map<string, string>();
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0]);
      if (!problems.has(key)) problems.set(key, issue.message);
    }
  }

  function submit() {
    setShowErrors(true);
    if (!parsed.success || !dirty) return;
    setState({ kind: "saving" });
    save.mutate(
      { containers: parsed.data },
      {
        onSuccess: () => {
          setEdits({});
          setShowErrors(false);
          setState({ kind: "saved" });
        },
        onError: (e) => setState({ kind: "error", message: e.message, details: e.details }),
      },
    );
  }

  return (
    <SaveSection
      title="Limits"
      note="Per container, and for the build of a preview"
      dirty={dirty}
      state={state}
      onSave={submit}
      onDiscard={() => {
        setEdits({});
        setShowErrors(false);
        setState(IDLE);
      }}
    >
      <form
        aria-label="Container limits"
        noValidate
        className="grid max-w-[640px] gap-3 @[480px]:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {LIMITS.map(({ key, label, hint }) => (
          <Field key={key} label={label} hint={hint} error={showErrors ? problems.get(key) : undefined}>
            {(p) => (
              <Input
                {...p}
                className="font-mono"
                value={value(key)}
                onChange={(e) => {
                  if (state.kind !== "saving") setState(IDLE);
                  setEdits((prev) => ({ ...prev, [key]: e.target.value }));
                }}
              />
            )}
          </Field>
        ))}
        <button type="submit" hidden />
      </form>
    </SaveSection>
  );
}
