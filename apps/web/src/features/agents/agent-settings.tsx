import {
  type AccountView,
  type AgentEntry,
  AUTO,
  connectionType,
  EFFORT_TIER_LABEL,
  EffortTierSchema,
  MODEL_TIER_LABEL,
  ModelTierSchema,
  type OrgView,
  TOOL_CATALOG,
  type ToolInfo,
  type ToolSetting,
  toolSetting,
  withToolSetting,
} from "@majhi/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { DetailSection } from "@/components/ui/list-detail";
import { MultiSelect } from "@/components/ui/multi-select";
import { PageLink } from "@/components/ui/page-link";
import { Segmented } from "@/components/ui/segmented";
import { Select, Textarea } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { orgLabel } from "@/features/accounts/model";
import { capFromField } from "@/features/boss/model";
import { useConnections } from "@/lib/connection-queries";
import { describeError, errorDetails } from "@/lib/errors";
import { queryKeys } from "@/lib/queries";
import { useAccountModels, useAgentAttached, useTools, useUpdateAgent } from "@/lib/studio-queries";
import {
  type AgentDraft,
  accountsForScope,
  autoFirst,
  buildOptions,
  draftFromAgent,
  entryId,
  fallbackCandidates,
  type OkAgent,
  PERMS,
  ROOT_SCOPE,
  rolesForScope,
  togglePerm,
  updateInput,
  withTier,
  worksOutsideScope,
} from "./model";

/** The settings sections and the draft fields each one saves. */
const SECTIONS = {
  role: ["role", "account", "where"],
  model: ["model", "effort", "models", "tier"],
  perms: ["perms"],
  tools: ["tools"],
  connections: ["connections"],
  fallback: ["fallback"],
  context: ["contextCap"],
  instructions: ["instructions"],
} as const satisfies Record<string, readonly (keyof AgentDraft)[]>;

type SectionId = keyof typeof SECTIONS;

type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string; details: string[] };

function pick(draft: AgentDraft, section: SectionId): Partial<AgentDraft> {
  return Object.fromEntries(SECTIONS[section].map((key) => [key, draft[key]]));
}

function same(a: AgentDraft, b: AgentDraft, section: SectionId): boolean {
  return JSON.stringify(pick(a, section)) === JSON.stringify(pick(b, section));
}

/**
 * The agent's settings in sections. Each section keeps its own unsaved changes and its own Save, and
 * saves only its fields over the file as it is now, so an edit in one never rides along with another.
 */
export function AgentSettings({
  entry,
  agents,
  accounts,
  orgs,
}: {
  entry: OkAgent;
  agents: readonly AgentEntry[];
  accounts: readonly AccountView[];
  orgs: readonly OrgView[];
}) {
  const update = useUpdateAgent();
  const client = useQueryClient();
  const base = draftFromAgent(entry.agent);
  const [drafts, setDrafts] = useState<Partial<Record<SectionId, AgentDraft>>>({});
  const [saves, setSaves] = useState<Partial<Record<SectionId, SaveState>>>({});
  const [serverWarnings, setServerWarnings] = useState<string[]>();

  /** What each section shows: its own draft, or the file. */
  const view = (section: SectionId): AgentDraft => drafts[section] ?? base;
  const dirty = (section: SectionId) => {
    const draft = drafts[section];
    return draft !== undefined && !same(draft, base, section);
  };
  const change = (section: SectionId, patch: Partial<AgentDraft>) => {
    setDrafts((prev) => ({ ...prev, [section]: { ...(prev[section] ?? base), ...patch } }));
    setSaves((prev) => ({ ...prev, [section]: { kind: "idle" } }));
  };
  const discard = (section: SectionId) => {
    setDrafts(({ [section]: _gone, ...rest }) => rest);
    setSaves((prev) => ({ ...prev, [section]: { kind: "idle" } }));
  };
  const save = (section: SectionId) => {
    const draft = drafts[section];
    if (!draft) return;
    setSaves((prev) => ({ ...prev, [section]: { kind: "saving" } }));
    update.mutate(updateInput(entry.agent, { ...base, ...pick(draft, section) }), {
      onSuccess: async (result) => {
        setServerWarnings(result.status === "ok" ? result.warnings : undefined);
        // Wait for the fresh file, so the section never flashes the old value.
        await client.invalidateQueries({ queryKey: queryKeys.agents }).catch(() => undefined);
        setDrafts(({ [section]: _saved, ...rest }) => rest);
        setSaves((prev) => ({ ...prev, [section]: { kind: "saved" } }));
      },
      onError: (error) =>
        setSaves((prev) => ({
          ...prev,
          [section]: { kind: "error", message: describeError(error), details: errorDetails(error) },
        })),
    });
  };

  const sectionProps = (section: SectionId) => ({
    dirty: dirty(section),
    state: saves[section] ?? { kind: "idle" as const },
    onSave: () => save(section),
    onDiscard: () => discard(section),
  });

  const warnings = serverWarnings ?? entry.warnings;

  return (
    <div className="flex flex-col">
      {warnings.length > 0 && (
        <ul
          aria-label="Warnings"
          className="mb-4 flex flex-col gap-1 rounded-lg border border-amber-line bg-amber-wash px-3 py-2"
        >
          {warnings.map((w) => (
            <li key={w} className="text-base text-amber text-pretty">
              {w}
            </li>
          ))}
        </ul>
      )}
      <RoleSection
        draft={view("role")}
        accounts={accounts}
        orgs={orgs}
        onChange={(patch) => change("role", patch)}
        {...sectionProps("role")}
      />
      <ModelSection
        draft={view("model")}
        account={view("role").account}
        onChange={(patch) => change("model", patch)}
        {...sectionProps("model")}
      />
      <PermsSection
        draft={view("perms")}
        onChange={(patch) => change("perms", patch)}
        {...sectionProps("perms")}
      />
      <ToolsSection
        agent={entry.agent.frontmatter.id}
        draft={view("tools")}
        onChange={(patch) => change("tools", patch)}
        {...sectionProps("tools")}
      />
      <ConnectionsSection
        draft={view("connections")}
        onChange={(patch) => change("connections", patch)}
        {...sectionProps("connections")}
      />
      <FallbackSection
        draft={view("fallback")}
        candidates={fallbackCandidates(agents, entry).map(entryId)}
        onChange={(patch) => change("fallback", patch)}
        {...sectionProps("fallback")}
      />
      <ContextSection
        draft={view("context")}
        tool={accounts.find((a) => a.id === view("role").account)?.tool}
        onChange={(patch) => change("context", patch)}
        {...sectionProps("context")}
      />
      <InstructionsSection
        draft={view("instructions")}
        onChange={(patch) => change("instructions", patch)}
        {...sectionProps("instructions")}
      />
    </div>
  );
}

interface SectionProps {
  draft: AgentDraft;
  onChange: (patch: Partial<AgentDraft>) => void;
  dirty: boolean;
  state: SaveState;
  onSave: () => void;
  onDiscard: () => void;
}

/** A settings section with Cancel and Save while it has changes, and what happened to the last save. */
function SettingsSection({
  title,
  note,
  dirty,
  state,
  onSave,
  onDiscard,
  children,
}: Pick<SectionProps, "dirty" | "state" | "onSave" | "onDiscard"> & {
  title: string;
  note?: string;
  children: ReactNode;
}) {
  const saving = state.kind === "saving";
  return (
    <DetailSection
      title={title}
      {...(note ? { note } : {})}
      actions={
        <>
          <span role="status" aria-live="polite" className="flex items-center gap-1 text-sm text-fg-faint">
            {state.kind === "saved" && !dirty && (
              <>
                <Check aria-hidden="true" className="size-3 text-green" />
                Saved
              </>
            )}
          </span>
          {(dirty || saving) && (
            <>
              <Button size="sm" variant="ghost" disabled={saving} onClick={onDiscard}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={saving}
                onClick={onSave}
                aria-label={`Save ${title}`}
              >
                {saving ? "Saving" : "Save"}
              </Button>
            </>
          )}
        </>
      }
    >
      {children}
      {state.kind === "error" && (
        <div role="alert" className="flex flex-col gap-1 text-sm text-red">
          <p>Could not save: {state.message}</p>
          {state.details.map((d) => (
            <p key={d} className="font-mono">
              {d}
            </p>
          ))}
        </div>
      )}
    </DetailSection>
  );
}

const GRID = "grid gap-3 @[560px]:grid-cols-2";

function RoleSection({
  draft,
  accounts,
  orgs,
  onChange,
  ...section
}: SectionProps & { accounts: readonly AccountView[]; orgs: readonly OrgView[] }) {
  const tools = useTools().data;
  const scopeAccounts = accountsForScope(accounts, draft.scope);
  const account = accounts.find((a) => a.id === draft.account);
  const fits = scopeAccounts.some((a) => a.id === draft.account);
  const choices = fits ? scopeAccounts : [...scopeAccounts, ...(account ? [account] : [])];
  const where = draft.where.includes("anywhere") ? [] : draft.where;
  return (
    <SettingsSection title="Role and account" {...section}>
      <div className="flex flex-col gap-1.5">
        <span className="text-sm text-fg-faint">Role</span>
        <Segmented
          label="Role"
          value={draft.role}
          segments={rolesForScope(draft.scope, draft.role).map((r) => ({ value: r, label: r }))}
          onChange={(role) => onChange({ role })}
          className="self-start"
        />
      </div>
      <div className={GRID}>
        <Field
          label="Account"
          error={
            !account
              ? `The account ${draft.account} does not exist.`
              : !fits
                ? `The account ${draft.account} cannot be used in scope ${draft.scope}.`
                : undefined
          }
        >
          {(p) => (
            <Select {...p} value={draft.account} onChange={(e) => onChange({ account: e.target.value })}>
              {!account && <option value={draft.account}>{draft.account} (not found)</option>}
              {choices.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.id} · {tools?.find((t) => t.id === a.tool)?.name ?? a.tool} ·{" "}
                  {orgLabel(a.org, orgs).name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="text-sm text-fg-faint">Where it can work</span>
          <MultiSelect
            label="Where it can work"
            options={orgs.map((o) => ({ value: o.id, label: o.name }))}
            value={where}
            onChange={(next) => onChange({ where: next.length === 0 ? ["anywhere"] : next })}
            emptyText="Anywhere"
            clearText="Anywhere"
          />
          {worksOutsideScope(draft.scope, draft.where) && (
            <p className="text-sm text-amber text-pretty">
              This agent will use {draft.account} on other workspaces' code. Allowed because you said so.
            </p>
          )}
        </div>
      </div>
    </SettingsSection>
  );
}

function ModelSection({ draft, account, onChange, ...section }: SectionProps & { account: string }) {
  const models = useAccountModels(account);
  const modelChoices = buildOptions("model", models.data?.models, draft.model, models.data?.defaultModel);
  const effortChoices = buildOptions(
    "effort",
    models.data?.efforts,
    draft.effort,
    models.data?.defaultEffort,
  );
  const autoModel = draft.model === AUTO;
  const autoEffort = draft.effort === AUTO;
  return (
    <SettingsSection title="Model and effort" note="Auto lets majhi pick for each run." {...section}>
      <div className={GRID}>
        <Field label="Model" warning={modelChoices.warning}>
          {(p) => (
            <Select
              {...p}
              value={draft.model ?? ""}
              onChange={(e) => onChange({ model: e.target.value || undefined })}
            >
              {autoFirst(modelChoices).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Effort" warning={effortChoices.warning}>
          {(p) => (
            <Select
              {...p}
              value={draft.effort ?? ""}
              onChange={(e) => onChange({ effort: e.target.value || undefined })}
            >
              {autoFirst(effortChoices).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {autoModel && (
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="text-sm text-fg-faint">Allowed for auto</span>
            <MultiSelect
              label="Models allowed for auto"
              options={(models.data?.models ?? []).map((m) => ({ value: m.id, label: m.id, mono: true }))}
              value={draft.models}
              onChange={(next) => onChange({ models: next })}
              emptyText="Every model the account offers"
              clearText="Allow every model"
            />
          </div>
        )}
        {autoModel && (
          <Field
            label="Model when there is no confident pick"
            hint="Chosen by price among the models on offer."
          >
            {(p) => (
              <Select
                {...p}
                value={draft.tier.model ?? ""}
                onChange={(e) =>
                  onChange({
                    tier: withTier(draft.tier, "model", ModelTierSchema.safeParse(e.target.value).data),
                  })
                }
              >
                <option value="">Role default</option>
                {ModelTierSchema.options.map((t) => (
                  <option key={t} value={t}>
                    {MODEL_TIER_LABEL[t]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        {autoEffort && (
          <Field
            label="Effort when there is no confident pick"
            hint="By position in the account's effort list, lowest first."
          >
            {(p) => (
              <Select
                {...p}
                value={draft.tier.effort ?? ""}
                onChange={(e) =>
                  onChange({
                    tier: withTier(draft.tier, "effort", EffortTierSchema.safeParse(e.target.value).data),
                  })
                }
              >
                <option value="">Role default</option>
                {EffortTierSchema.options.map((t) => (
                  <option key={t} value={t}>
                    {EFFORT_TIER_LABEL[t]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
      </div>
      {models.isError && (
        <p className="text-sm text-fg-faint">
          Could not read this account's models: {describeError(models.error)}
        </p>
      )}
    </SettingsSection>
  );
}

function PermsSection({ draft, onChange, ...section }: SectionProps) {
  return (
    <SettingsSection title="Permissions" note="Reading code is always allowed." {...section}>
      <div className="grid grid-cols-2 gap-x-6 gap-y-1 @[560px]:grid-cols-3">
        {PERMS.map((perm) => (
          <Switch
            key={perm.id}
            label={perm.label}
            checked={draft.perms.includes(perm.id)}
            onChange={(on) => onChange({ perms: togglePerm(draft.perms, perm.id, on) })}
          />
        ))}
      </div>
    </SettingsSection>
  );
}

const TOOL_SETTINGS = [
  { value: "default", label: "Default" },
  { value: "added", label: "Add" },
  { value: "off", label: "Off" },
] as const satisfies readonly { value: ToolSetting; label: string }[];

/** Which MCP servers the agent gets: the role decides, and the agent can add one or turn a default off. */
function ToolsSection({ agent, draft, onChange, ...section }: SectionProps & { agent: string }) {
  const attached = useAgentAttached(agent).data;
  return (
    <SettingsSection
      title="Tools"
      note="The MCP servers a run attaches. Each is on or off by its role's rule; Add gives one the role does not get, Off takes a default away."
      {...section}
    >
      <ul className="flex flex-col gap-2">
        {TOOL_CATALOG.map((tool) => (
          <li key={tool.name} className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <div className="font-mono text-base">{tool.name}</div>
              <div className="text-sm text-fg-muted text-pretty">
                {tool.summary}. {tool.rule}.
              </div>
            </div>
            <Segmented
              label={`${tool.name} setting`}
              value={toolSetting(draft.tools, tool.name)}
              segments={TOOL_SETTINGS}
              onChange={(setting) => onChange({ tools: withToolSetting(draft.tools, tool.name, setting) })}
            />
          </li>
        ))}
      </ul>
      <p className="mt-3 text-sm text-fg-muted text-pretty">
        {attached
          ? `Latest run (${attached.task}) attached: ${attached.tools.length === 0 ? "nothing" : attached.tools.join(", ")}.`
          : "No run has recorded its tools yet."}
      </p>
    </SettingsSection>
  );
}

/**
 * The connections of the agent's org it may use (5.14). A root agent lists none: it gets every
 * connection of the task's org. An org agent never gets another org's connection.
 */
function ConnectionsSection({ draft, onChange, ...section }: SectionProps) {
  const connections = useConnections().data;
  if (draft.scope === ROOT_SCOPE) {
    return (
      <DetailSection title="Connections">
        <p className="text-sm text-fg-muted text-pretty">
          A root agent gets every connection of the task's workspace, and can attach one of another workspace
          to a task. Each attach shows in the room.
        </p>
      </DetailSection>
    );
  }
  const own = (connections ?? []).filter((c) => c.org === draft.scope);
  const gone = draft.connections.filter((id) => connections !== undefined && !own.some((c) => c.id === id));
  return (
    <SettingsSection
      title="Connections"
      note="What it may reach outside its repos. Only this workspace's connections."
      {...section}
    >
      {own.length === 0 ? (
        <p className="text-sm text-fg-muted text-pretty">
          This workspace has no connections yet.{" "}
          <PageLink page="connections" className="text-fg underline-offset-2 hover:underline">
            Add one
          </PageLink>
          .
        </p>
      ) : (
        <MultiSelect
          label="Connections"
          className="@[560px]:max-w-[calc(50%-6px)]"
          options={own.map((c) => ({ value: c.id, label: `${c.name} (${connectionType(c.type).label})` }))}
          value={draft.connections.filter((id) => own.some((c) => c.id === id))}
          onChange={(next) => onChange({ connections: [...next, ...gone] })}
          emptyText="None"
          clearText="None"
        />
      )}
      {gone.length > 0 && (
        <p className="text-sm text-amber text-pretty">
          Lists {gone.join(", ")}, which {gone.length === 1 ? "is not a connection" : "are not connections"}{" "}
          of this workspace. It gets {gone.length === 1 ? "it" : "them"} nowhere.{" "}
          <button
            type="button"
            className="cursor-pointer text-fg underline-offset-2 hover:underline"
            onClick={() => onChange({ connections: draft.connections.filter((id) => !gone.includes(id)) })}
          >
            Remove from the list
          </button>
        </p>
      )}
    </SettingsSection>
  );
}

function FallbackSection({
  draft,
  candidates,
  onChange,
  ...section
}: SectionProps & { candidates: string[] }) {
  const missing = draft.fallback !== undefined && !candidates.includes(draft.fallback);
  return (
    <SettingsSection title="When usage runs out or the run breaks" {...section}>
      <Field
        label="Hand the run to"
        hint="Another agent takes over, or the run waits for the account to reset."
      >
        {(p) => (
          <Select
            {...p}
            className="@[560px]:max-w-[calc(50%-6px)]"
            value={draft.fallback ?? ""}
            onChange={(e) => onChange({ fallback: e.target.value || undefined })}
          >
            <option value="">No fallback, wait</option>
            {candidates.map((id) => (
              <option key={id} value={id}>
                @{id}
              </option>
            ))}
            {missing && <option value={draft.fallback}>@{draft.fallback} (not found)</option>}
          </Select>
        )}
      </Field>
    </SettingsSection>
  );
}

/** What the cap does for this agent's CLI inside a turn: majhi's own compaction runs between turns. */
function midTurnNote(tool: ToolInfo | undefined, capK: number | undefined): string | undefined {
  if (tool === undefined) return undefined;
  if (tool.midTurnCapMin === undefined) {
    return `${tool.name} cannot be capped inside a turn. majhi compacts it at the end of each turn, so one long turn can pass the cap.`;
  }
  if (capK !== undefined && capK > 0 && capK * 1000 < tool.midTurnCapMin) {
    return `${tool.name} does not compact inside a turn below ${tool.midTurnCapMin / 1000}k. majhi compacts it at the end of each turn.`;
  }
  return undefined;
}

function ContextSection({
  draft,
  tool,
  onChange,
  ...section
}: SectionProps & { tool: ToolInfo["id"] | undefined }) {
  const tools = useTools().data;
  const info = tools?.find((t) => t.id === tool);
  const text = draft.contextCap.trim();
  const parsed = text === "" ? undefined : capFromField(text);
  const note = midTurnNote(info, parsed?.value === undefined ? undefined : parsed.value / 1000);
  return (
    <SettingsSection
      title="Context cap"
      note="Most tokens a session may use, whatever the model allows. Each tool call re-sends the context, so a lower cap spends less."
      {...section}
    >
      <Field
        label="Cap (k tokens)"
        hint="Blank uses the org's or majhi's setting. 0 is no cap: the model's full window."
        {...(parsed?.error === undefined ? {} : { error: parsed.error })}
      >
        {(p) => (
          <Input
            {...p}
            inputMode="numeric"
            className="font-mono @[560px]:max-w-[calc(50%-6px)]"
            placeholder="Inherit"
            value={draft.contextCap}
            onChange={(e) => onChange({ contextCap: e.target.value })}
          />
        )}
      </Field>
      {note !== undefined && <p className="m-0 text-sm text-amber text-pretty">{note}</p>}
    </SettingsSection>
  );
}

function InstructionsSection({ draft, onChange, ...section }: SectionProps) {
  return (
    <SettingsSection title="Instructions" {...section}>
      <Textarea
        aria-label="Instructions"
        rows={7}
        value={draft.instructions}
        placeholder="How this agent should work, in plain words."
        onChange={(e) => onChange({ instructions: e.target.value })}
        className="min-h-28 rounded-[10px] border-line-strong bg-sunken px-3.5 py-3 font-sans text-base leading-[1.55] text-fg"
      />
    </SettingsSection>
  );
}
