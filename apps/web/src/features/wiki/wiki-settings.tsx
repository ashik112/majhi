import { Check } from "lucide-react";
import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { DetailSection } from "@/components/ui/list-detail";
import { OrgBadge } from "@/components/ui/org-badge";
import { PageLink } from "@/components/ui/page-link";
import { Segmented } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { useSaveSettings, useSettings } from "@/lib/boss-queries";
import { describeError } from "@/lib/errors";
import { badgeLetters, formatAgo } from "@/lib/format";
import { usePlaybooksAcross } from "@/lib/playbook-queries";
import { useAccountModels, useAgents, useUpdateOrg } from "@/lib/studio-queries";
import { COPY } from "./copy";
import { useWikiWorkspaces, type WikiWorkspace } from "./use-wiki-switch";

/** The id of the playbook that keeps the wiki up to date. */
const UPKEEP = "upkeep-wiki";

const OFF_NOTES = [
  "No pages are built or refreshed.",
  "Agents get no wiki tool and tasks get no wiki section.",
  "The sidebar has no Wiki entry.",
  "Pages you already have are kept, so turning it back on is instant.",
] as const;

/** The words the status line gives a workspace: on or off, and why. */
function stateOf(w: WikiWorkspace): string {
  if (w.choice === "default") return `Follows the default, so it is ${w.enabled ? "on" : "off"}`;
  return w.enabled ? "On for this workspace" : "Off for this workspace";
}

/**
 * Settings, Agents, Wiki: majhi's default and each workspace's own choice. A change applies at once, because a
 * switch has nothing to draft: the wiki entry appears in the sidebar and the page follows.
 */
export function WikiSection() {
  const { workspaces, globalOn } = useWikiWorkspaces();
  const saveSettings = useSaveSettings();
  const updateOrg = useUpdateOrg();
  const toast = useToast();
  const settings = useSettings().data;
  const agents = useAgents();
  // The writer runs as the Housekeeper does: the chosen Housekeeper's account, else the captain's.
  const ok = (agents.data ?? []).flatMap((a) => (a.status === "ok" ? [a] : []));
  const housekeeper = settings?.memory.housekeeper;
  const writer =
    housekeeper === undefined
      ? ok.find((a) => a.isBoss)?.agent.frontmatter
      : ok.find((a) => a.agent.frontmatter.id === housekeeper)?.agent.frontmatter;
  const models = useAccountModels(writer?.account).data?.models ?? [];
  const model = settings?.wiki.writer_model ?? "";
  const on = useMemo(() => workspaces.filter((w) => w.enabled), [workspaces]);
  const upkeep = usePlaybooksAcross(on.map((w) => w.org.id));
  const fail = (e: unknown) => toast("Could not change it", { detail: describeError(e), tone: "error" });

  if (globalOn === undefined) return <p className="pt-5 text-sm text-fg-faint">Loading</p>;
  return (
    <>
      <DetailSection
        title="All workspaces"
        note="The default. A workspace can override it below."
        className="border-t-0"
      >
        <div className="flex items-center gap-4">
          <div className="min-w-0 flex-1">
            <p className="text-body font-medium text-fg">Wiki</p>
            <p className="text-sm text-fg-muted">
              Off until a workspace asks for it, or until you turn it on here.
            </p>
          </div>
          <Segmented
            label="Wiki for all workspaces"
            value={globalOn ? "on" : "off"}
            onChange={(v) => saveSettings.mutate({ wiki: { enabled: v === "on" } }, { onError: fail })}
            segments={[
              { value: "off", label: "Off" },
              { value: "on", label: "On" },
            ]}
          />
        </div>
        <Field
          label="Writer model"
          hint={
            writer === undefined
              ? "Choose a captain or a Housekeeper in Memory first."
              : `The model that writes the pages, from ${writer.account}. Default is its balanced model.`
          }
        >
          {(p) => (
            <Select
              {...p}
              className="max-w-[320px]"
              value={model}
              disabled={writer === undefined}
              onChange={(e) =>
                saveSettings.mutate(
                  { wiki: { writer_model: e.target.value === "" ? null : e.target.value } },
                  { onError: fail },
                )
              }
            >
              <option value="">Default</option>
              {model !== "" && !models.some((m) => m.id === model) && <option value={model}>{model}</option>}
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </DetailSection>
      <DetailSection title="Per workspace">
        <ul className="m-0 flex list-none flex-col p-0">
          {workspaces.map((w) => (
            <li
              key={w.org.id}
              className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line py-2.5 last:border-b-0"
            >
              <div className="flex min-w-0 flex-1 basis-[220px] items-center gap-2.5">
                <OrgBadge label={badgeLetters(w.org.key)} color={w.org.color} size="md" />
                <div className="min-w-0">
                  <p className="truncate text-body font-medium text-fg">{w.org.name}</p>
                  <p className="truncate text-sm text-fg-muted">{stateOf(w)}</p>
                </div>
              </div>
              <Segmented
                label={`Wiki for ${w.org.name}`}
                value={w.choice}
                onChange={(v) =>
                  updateOrg.mutate(
                    { id: w.org.id, wiki: v === "default" ? null : { enabled: v === "on" } },
                    { onError: fail },
                  )
                }
                segments={[
                  { value: "default", label: "Default" },
                  { value: "on", label: "On" },
                  { value: "off", label: "Off" },
                ]}
              />
            </li>
          ))}
        </ul>
      </DetailSection>
      <DetailSection title={COPY.settings.upkeep}>
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-[220px] flex-1 text-sm text-fg-muted">{COPY.settings.upkeepWords}</p>
          <Button asChild>
            <PageLink page="playbooks">{COPY.settings.openPlaybook}</PageLink>
          </Button>
        </div>
        {on.length > 0 && (
          <ul className="m-0 flex list-none flex-col p-0">
            {on.map((w, i) => {
              const row = upkeep[i]?.data?.playbooks.find((p) => p.playbook.id === UPKEEP);
              return (
                <li
                  key={w.org.id}
                  className="flex items-center gap-2.5 border-b border-line py-2 text-base last:border-b-0"
                >
                  <OrgBadge label={badgeLetters(w.org.key)} color={w.org.color} size="md" />
                  <span className="min-w-0 flex-1 truncate text-fg">{w.org.name}</span>
                  <span className="text-sm text-fg-muted">{upkeepState(row)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </DetailSection>
      <DetailSection title={COPY.settings.whenOff}>
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {OFF_NOTES.map((line) => (
            <li key={line} className="flex items-start gap-2 text-base text-fg-soft">
              <Check aria-hidden="true" className="mt-1 size-3.5 shrink-0 text-fg-faint" />
              {line}
            </li>
          ))}
        </ul>
      </DetailSection>
    </>
  );
}

/** What the upkeep playbook of a workspace is doing, in a few words. */
function upkeepState(
  row:
    | { enabled: boolean; running: boolean; held?: string | undefined; lastRun?: string | undefined }
    | undefined,
): string {
  if (row === undefined) return COPY.settings.noPlaybook;
  if (!row.enabled) return COPY.settings.off;
  if (row.running) return COPY.settings.running;
  if (row.held !== undefined) return COPY.settings.held(row.held);
  return row.lastRun === undefined
    ? COPY.settings.on
    : COPY.settings.lastRun(formatAgo(row.lastRun, Date.now()));
}
