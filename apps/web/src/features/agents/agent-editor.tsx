import type { AccountView, AgentEntry, HealthCheck, OrgView, Perm } from "@majhi/shared";
import {
  AUTO,
  collapseHome,
  EFFORT_TIER_LABEL,
  EffortTierSchema,
  IdSchema,
  MODEL_TIER_LABEL,
  ModelTierSchema,
} from "@majhi/shared";
import { Check, Ellipsis } from "lucide-react";
import * as m from "motion/react-m";
import { useEffect, useRef, useState } from "react";
import { AgentAvatar } from "@/components/agent-avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ALLOWED, ChoiceChip } from "@/components/ui/choice-chip";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Menu } from "@/components/ui/menu";
import { Modal } from "@/components/ui/modal";
import { Textarea } from "@/components/ui/select";
import { HealthDialog } from "@/features/accounts/health-dialog";
import { orgLabel } from "@/features/accounts/model";
import { cn } from "@/lib/cn";
import { describeError, errorDetails } from "@/lib/errors";
import { useConfig } from "@/lib/queries";
import {
  useAccountModels,
  useAgentHealth,
  useDuplicateAgent,
  useRemoveAgent,
  useRenameAgent,
  useSetBoss,
  useTools,
  useUpdateAgent,
} from "@/lib/studio-queries";
import {
  type AgentDraft,
  type AgentState,
  accountsForScope,
  buildOptions,
  draftFromAgent,
  entryId,
  fallbackCandidates,
  type OkAgent,
  optionChips,
  PERMS,
  ROOT_SCOPE,
  rolesForScope,
  togglePerm,
  toggleWhere,
  updateInput,
  withTier,
  worksOutsideScope,
} from "./model";
import { UsageStrip } from "./usage-strip";

const SAVE_DELAY_MS = 600;

type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string; details: string[] };

export interface AgentEditorProps {
  entry: OkAgent;
  agents: readonly AgentEntry[];
  accounts: readonly AccountView[];
  orgs: readonly OrgView[];
  state: AgentState;
  now: number;
  onHealth: (id: string, health: HealthCheck) => void;
  onSelect: (id: string | undefined) => void;
}

/** Edits one agent file. Every change saves after a short pause, so there is no Save button. */
export function AgentEditor({
  entry,
  agents,
  accounts,
  orgs,
  state,
  now,
  onHealth,
  onSelect,
}: AgentEditorProps) {
  const id = entry.agent.frontmatter.id;
  const update = useUpdateAgent();
  const boss = useSetBoss();
  const [draft, setDraft] = useState<AgentDraft>(() => draftFromAgent(entry.agent));
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const [serverWarnings, setServerWarnings] = useState<string[]>();
  const [dialog, setDialog] = useState<"duplicate" | "rename" | "health" | "remove" | null>(null);

  const latest = useRef(draft);
  const entryRef = useRef(entry);
  entryRef.current = entry;
  const timer = useRef<number | undefined>(undefined);
  const dirty = useRef(false);
  const inFlight = useRef(false);
  const mutate = useRef(update.mutate);
  mutate.current = update.mutate;

  function flush() {
    window.clearTimeout(timer.current);
    if (!dirty.current) return;
    dirty.current = false;
    inFlight.current = true;
    setSave({ kind: "saving" });
    mutate.current(updateInput(entryRef.current.agent, latest.current), {
      onSuccess: (result) => {
        inFlight.current = false;
        setSave(dirty.current ? { kind: "saving" } : { kind: "saved" });
        setServerWarnings(result.status === "ok" ? result.warnings : undefined);
      },
      onError: (error) => {
        inFlight.current = false;
        setSave({ kind: "error", message: describeError(error), details: errorDetails(error) });
      },
    });
  }

  function change(patch: Partial<AgentDraft>) {
    const next = { ...latest.current, ...patch };
    latest.current = next;
    setDraft(next);
    dirty.current = true;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, SAVE_DELAY_MS);
  }

  // Save a pending change when the editor closes or another agent opens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: flush reads refs only
  useEffect(() => flush, []);

  // A hand edit of the file shows up here when there is nothing unsaved.
  useEffect(() => {
    if (dirty.current || inFlight.current) return;
    const fresh = draftFromAgent(entry.agent);
    if (JSON.stringify(fresh) !== JSON.stringify(latest.current)) {
      latest.current = fresh;
      setDraft(fresh);
    }
  }, [entry]);

  const models = useAccountModels(draft.account);
  const tools = useTools();
  const home = useConfig().data?.home;
  const scopeAccounts = accountsForScope(accounts, draft.scope);
  const account = accounts.find((a) => a.id === draft.account);
  const accountFits = scopeAccounts.some((a) => a.id === draft.account);
  const modelChoices = buildOptions("model", models.data?.models, draft.model, models.data?.defaultModel);
  const effortChoices = buildOptions(
    "effort",
    models.data?.efforts,
    draft.effort,
    models.data?.defaultEffort,
  );
  const warnings = [
    ...(serverWarnings ?? entry.warnings),
    ...(accountFits ? [] : [`The account ${draft.account} cannot be used in scope ${draft.scope}.`]),
  ];
  const fallbacks = fallbackCandidates(agents, entry);
  const bossBlock = entry.isBoss
    ? "The boss cannot be removed. Make another root agent the boss first."
    : undefined;
  const whereOptions = [
    { id: "anywhere", name: "Anywhere" },
    ...orgs.map((o) => ({ id: o.id, name: o.name })),
  ];
  const accountChoices = accountFits ? scopeAccounts : [...scopeAccounts, ...(account ? [account] : [])];

  return (
    <m.div
      initial={{ opacity: 0, y: 3 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
      className="flex min-w-0 flex-1 flex-col gap-4 overflow-auto px-7 pt-[18px] pb-7"
    >
      <div className="flex flex-wrap items-center gap-3">
        <AgentAvatar id={id} role={draft.role} size={36} decorative ring="border-canvas" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="font-mono text-[1.0625rem] leading-6 font-semibold">@{id}</h2>
          <p className="truncate font-mono text-xs text-fg-faint" title={entry.file}>
            {home ? collapseHome(entry.file, home) : entry.file}
          </p>
        </div>
        {entry.isBoss && (
          <Badge tone="amber" className="h-6 rounded-full px-2.5 text-xs">
            Boss
          </Badge>
        )}
        {entry.agent.frontmatter.origin === "setup" && (
          <Badge tone="blue" className="h-6 rounded-full px-2.5 text-xs">
            Drafted by @setup
          </Badge>
        )}
        <SaveStatus state={save} />
        <div className="ml-auto flex items-center gap-1.5">
          <fieldset aria-label="Role" className="m-0 flex gap-1.5 border-0 p-0">
            {rolesForScope(draft.scope, draft.role).map((role) => (
              <ChoiceChip
                key={role}
                pressed={draft.role === role}
                className="h-[34px] px-2.5"
                onClick={() => change({ role })}
              >
                {role}
              </ChoiceChip>
            ))}
          </fieldset>
          <Button className="ml-1.5" onClick={() => setDialog("health")}>
            Health check
          </Button>
          <Menu
            label="Agent actions"
            icon={<Ellipsis aria-hidden="true" />}
            items={[
              { label: "Rename", onSelect: () => setDialog("rename") },
              { label: "Duplicate", onSelect: () => setDialog("duplicate") },
              ...(draft.scope === ROOT_SCOPE && !entry.isBoss
                ? [{ label: "Make boss", onSelect: () => boss.mutate(id) }]
                : []),
              {
                label: entry.isBoss ? "Remove (the boss cannot be removed)" : "Remove",
                onSelect: () => setDialog("remove"),
                disabled: entry.isBoss,
                tone: "danger" as const,
              },
            ]}
          />
        </div>
      </div>
      {bossBlock && <p className="sr-only">{bossBlock}</p>}
      {boss.isError && (
        <p role="alert" className="text-sm text-red">
          Could not make {id} the boss: {describeError(boss.error)}
        </p>
      )}

      {warnings.length > 0 && (
        <ul
          aria-label="Warnings"
          className="flex flex-col gap-1 rounded-lg border border-amber-line bg-amber-wash px-3 py-2"
        >
          {warnings.map((w) => (
            <li key={w} className="text-base text-amber text-pretty">
              {w}
            </li>
          ))}
        </ul>
      )}
      {save.kind === "error" && (
        <div
          role="alert"
          className="flex flex-col gap-1 rounded-lg border border-red-line bg-red-wash px-3 py-2 text-base text-red"
        >
          <p>Could not save: {save.message}</p>
          {save.details.map((d) => (
            <p key={d} className="font-mono text-sm">
              {d}
            </p>
          ))}
        </div>
      )}

      <UsageStrip state={state} account={account} accountId={draft.account} now={now} />

      <div className="grid grid-cols-2 gap-x-[18px] gap-y-4">
        <Group label="Account">
          {accountChoices.map((a) => {
            const org = orgLabel(a.org, orgs);
            const tool = tools.data?.find((t) => t.id === a.tool)?.name ?? a.tool;
            return (
              <ChoiceChip
                key={a.id}
                pressed={draft.account === a.id}
                aria-label={`${a.id}, ${tool}, ${org.name}`}
                className="min-h-11 flex-col items-start gap-px px-2.5 py-1"
                onClick={() => change({ account: a.id })}
              >
                <span className="font-mono text-sm">{a.id}</span>
                <span className="text-[0.625rem] leading-4 font-normal text-fg-faint">
                  {tool} · {org.name}
                </span>
              </ChoiceChip>
            );
          })}
          {!account && <span className="text-sm text-red">The account {draft.account} does not exist.</span>}
        </Group>
        <div className="flex flex-col gap-4">
          <Group label="Model" warning={modelChoices.warning}>
            {optionChips(modelChoices, models.data?.models).map((o) => (
              <ChoiceChip
                key={o.value}
                mono={o.value !== "" && o.value !== AUTO}
                pressed={(draft.model ?? "") === o.value}
                title={o.title}
                className="h-11 px-3"
                onClick={() => change({ model: o.value || undefined })}
              >
                {o.label}
              </ChoiceChip>
            ))}
          </Group>
          <Group label="Effort" warning={effortChoices.warning}>
            {optionChips(effortChoices, models.data?.efforts).map((o) => (
              <ChoiceChip
                key={o.value}
                mono={o.value !== "" && o.value !== AUTO}
                pressed={(draft.effort ?? "") === o.value}
                title={o.title}
                onClick={() => change({ effort: o.value || undefined })}
              >
                {o.label}
              </ChoiceChip>
            ))}
          </Group>
        </div>
        {models.isError && (
          <p className="col-span-2 -mt-2 text-sm text-fg-faint">
            Could not read this account's models: {describeError(models.error)}
          </p>
        )}

        {draft.model === AUTO && (
          <div className="col-span-2">
            <Group
              label="Models allowed for auto"
              note="Leave all off to allow every model the account offers."
            >
              {(models.data?.models ?? []).map((m) => (
                <ChoiceChip
                  key={m.id}
                  mono
                  pressed={draft.models.includes(m.id)}
                  onClick={() =>
                    change({
                      models: draft.models.includes(m.id)
                        ? draft.models.filter((x) => x !== m.id)
                        : [...draft.models, m.id],
                    })
                  }
                >
                  {m.id}
                </ChoiceChip>
              ))}
            </Group>
          </div>
        )}

        {(draft.model === AUTO || draft.effort === AUTO) && (
          <div className="col-span-2 flex flex-col gap-4">
            {draft.model === AUTO && (
              <Group
                label="Model when there is no confident pick"
                note="Chosen by price among the models on offer. Role default follows Hub setup and the org."
              >
                <ChoiceChip
                  pressed={draft.tier.model === undefined}
                  onClick={() => change({ tier: withTier(draft.tier, "model", undefined) })}
                >
                  Role default
                </ChoiceChip>
                {ModelTierSchema.options.map((t) => (
                  <ChoiceChip
                    key={t}
                    pressed={draft.tier.model === t}
                    onClick={() => change({ tier: withTier(draft.tier, "model", t) })}
                  >
                    {MODEL_TIER_LABEL[t]}
                  </ChoiceChip>
                ))}
              </Group>
            )}
            {draft.effort === AUTO && (
              <Group
                label="Effort when there is no confident pick"
                note="Chosen by position in the account's effort list, lowest first."
              >
                <ChoiceChip
                  pressed={draft.tier.effort === undefined}
                  onClick={() => change({ tier: withTier(draft.tier, "effort", undefined) })}
                >
                  Role default
                </ChoiceChip>
                {EffortTierSchema.options.map((t) => (
                  <ChoiceChip
                    key={t}
                    pressed={draft.tier.effort === t}
                    onClick={() => change({ tier: withTier(draft.tier, "effort", t) })}
                  >
                    {EFFORT_TIER_LABEL[t]}
                  </ChoiceChip>
                ))}
              </Group>
            )}
          </div>
        )}

        <Group
          label="Where it can work"
          {...(worksOutsideScope(draft.scope, draft.where)
            ? {
                warning: `This agent will use ${draft.account} on other orgs' code. Allowed because you said so.`,
              }
            : {})}
        >
          {whereOptions.map((o) => (
            <ChoiceChip
              key={o.id}
              pressed={draft.where.includes(o.id)}
              onClick={() => change({ where: toggleWhere(draft.where, o.id) })}
            >
              {o.name}
            </ChoiceChip>
          ))}
        </Group>
        <Group
          label="When usage runs out or the run breaks"
          note="Hand the run to another agent, or wait for the account to reset."
        >
          <ChoiceChip pressed={draft.fallback === undefined} onClick={() => change({ fallback: undefined })}>
            No fallback, wait
          </ChoiceChip>
          {fallbacks.map((a) => (
            <ChoiceChip
              key={entryId(a)}
              mono
              pressed={draft.fallback === entryId(a)}
              aria-label={`Hand off to @${entryId(a)}`}
              onClick={() => change({ fallback: entryId(a) })}
            >
              @{entryId(a)}
            </ChoiceChip>
          ))}
          {draft.fallback && !fallbacks.some((a) => entryId(a) === draft.fallback) && (
            <ChoiceChip mono pressed onClick={() => change({ fallback: undefined })}>
              @{draft.fallback} (not found)
            </ChoiceChip>
          )}
        </Group>
      </div>

      <Field label="Instructions">
        {(p) => (
          <Textarea
            {...p}
            rows={4}
            value={draft.instructions}
            onChange={(e) => change({ instructions: e.target.value })}
            className="rounded-[10px] border-line-strong bg-sunken px-3.5 py-3 text-[0.8125rem] leading-[1.55] text-fg"
          />
        )}
      </Field>

      <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
        <legend className="mb-2 p-0 text-sm text-fg-faint">Permissions</legend>
        <div className="grid grid-cols-6 gap-2">
          <div
            className={cn("flex h-[50px] flex-col justify-center gap-0.5 rounded-lg border px-2.5", ALLOWED)}
          >
            <span className="text-sm">Read code</span>
            <span className="text-xs text-green">
              Allowed<span className="sr-only">, always</span>
            </span>
          </div>
          {PERMS.map((perm) => {
            const on = draft.perms.includes(perm.id);
            return (
              <button
                key={perm.id}
                type="button"
                aria-pressed={on}
                aria-label={`${perm.label}: ${on ? "Allowed" : "Off"}`}
                onClick={() => change({ perms: togglePerm(draft.perms, perm.id as Perm, !on) })}
                className={cn(
                  "flex h-[50px] cursor-pointer flex-col items-start justify-center gap-0.5 rounded-lg border px-2.5 text-left transition-[background-color,border-color] duration-150",
                  on ? ALLOWED : "border-line-strong bg-card hover:border-line-hover",
                )}
              >
                <span className="text-sm text-fg">{perm.label}</span>
                <span className={cn("text-xs", on ? "text-green" : "text-fg-faint")}>
                  {on ? "Allowed" : "Off"}
                </span>
              </button>
            );
          })}
        </div>
      </fieldset>

      {dialog === "duplicate" && (
        <DuplicateDialog id={id} onClose={() => setDialog(null)} onDone={(newId) => onSelect(newId)} />
      )}
      {dialog === "rename" && (
        <RenameDialog id={id} onClose={() => setDialog(null)} onDone={(newId) => onSelect(newId)} />
      )}
      {dialog === "health" && (
        <AgentHealthDialog id={id} onClose={() => setDialog(null)} onHealth={onHealth} />
      )}
      {dialog === "remove" && (
        <RemoveAgentDialog id={id} onClose={() => setDialog(null)} onDone={() => onSelect(undefined)} />
      )}
    </m.div>
  );
}

/** A label over a wrapping row of chips, with an optional note or warning below. */
function Group({
  label,
  note,
  warning,
  children,
}: {
  label: string;
  note?: string;
  warning?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
      <legend className="mb-2 p-0 text-sm text-fg-faint">{label}</legend>
      <div className="flex flex-wrap gap-1.5">{children}</div>
      {warning && <p className="text-sm text-amber text-pretty">{warning}</p>}
      {note && <p className="text-sm text-fg-muted text-pretty">{note}</p>}
    </fieldset>
  );
}

function SaveStatus({ state }: { state: SaveState }) {
  const text = { idle: "", saving: "Saving", saved: "Saved", error: "Not saved" }[state.kind];
  return (
    <span
      role="status"
      aria-live="polite"
      className={cn("flex items-center gap-1 text-sm", state.kind === "error" ? "text-red" : "text-fg-faint")}
    >
      {state.kind === "saved" && <Check aria-hidden="true" className="size-3 text-green" />}
      {text}
    </span>
  );
}

function DuplicateDialog({
  id,
  onClose,
  onDone,
}: {
  id: string;
  onClose: () => void;
  onDone: (newId: string) => void;
}) {
  const duplicate = useDuplicateAgent();
  const [newId, setNewId] = useState(`${id}-2`);
  return (
    <Modal label={`Duplicate @${id}`} onClose={onClose} className="w-[440px]">
      <form
        className="flex flex-col gap-4 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          duplicate.mutate(
            { id, newId: newId.trim() },
            {
              onSuccess: () => {
                onDone(newId.trim());
                onClose();
              },
            },
          );
        }}
      >
        <h2 className="text-md font-semibold">Duplicate @{id}</h2>
        <Field label="New agent id" error={duplicate.isError ? describeError(duplicate.error) : undefined}>
          {(p) => (
            <Input
              {...p}
              className="font-mono"
              value={newId}
              onChange={(e) => setNewId(e.target.value)}
              autoFocus
            />
          )}
        </Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={duplicate.isPending || newId.trim() === ""}>
            Duplicate
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function RenameDialog({
  id,
  onClose,
  onDone,
}: {
  id: string;
  onClose: () => void;
  onDone: (newId: string) => void;
}) {
  const rename = useRenameAgent();
  const [newId, setNewId] = useState(id);
  const next = newId.trim();
  const valid = IdSchema.safeParse(next).success;
  return (
    <Modal label={`Rename @${id}`} onClose={onClose} className="w-[440px]">
      <form
        className="flex flex-col gap-4 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          rename.mutate(
            { id, newId: next },
            {
              onSuccess: () => {
                onDone(next);
                onClose();
              },
            },
          );
        }}
      >
        <h2 className="text-md font-semibold">Rename @{id}</h2>
        <Field
          label="New agent id"
          hint="Tasks, the boss setting and fallbacks follow. Old room messages keep the old handle."
          error={
            rename.isError
              ? describeError(rename.error)
              : next !== id && !valid
                ? "Use lowercase letters, digits and dashes"
                : undefined
          }
        >
          {(p) => (
            <Input
              {...p}
              className="font-mono"
              value={newId}
              onChange={(e) => setNewId(e.target.value)}
              autoFocus
            />
          )}
        </Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={rename.isPending || next === id || !valid}>
            Rename
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function AgentHealthDialog({
  id,
  onClose,
  onHealth,
}: {
  id: string;
  onClose: () => void;
  onHealth: (id: string, h: HealthCheck) => void;
}) {
  const check = useAgentHealth();
  return (
    <HealthDialog
      title={`Health check: @${id}`}
      run={async () => {
        const health = await check.mutateAsync(id);
        onHealth(id, health);
        return health;
      }}
      onClose={onClose}
    />
  );
}

function RemoveAgentDialog({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: () => void }) {
  const remove = useRemoveAgent();
  return (
    <ConfirmDialog
      title={`Remove @${id}?`}
      body="This deletes the agent file from ~/.majhi/agents."
      confirmLabel="Remove agent"
      busy={remove.isPending}
      error={remove.isError ? describeError(remove.error) : undefined}
      onCancel={onClose}
      onConfirm={() =>
        remove.mutate(id, {
          onSuccess: () => {
            onClose();
            onDone();
          },
        })
      }
    />
  );
}
