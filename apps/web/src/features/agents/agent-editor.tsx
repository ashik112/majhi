import type { AccountView, AgentEntry, HealthCheck, OrgView, Perm } from "@majhi/shared";
import { AUTO } from "@majhi/shared";
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { Select, Textarea } from "@/components/ui/select";
import { StatusDot, TONE_TEXT } from "@/components/ui/status-dot";
import { Switch } from "@/components/ui/switch";
import { HealthDialog } from "@/features/accounts/health-dialog";
import { statusInfo } from "@/features/accounts/model";
import { cn } from "@/lib/cn";
import { describeError, errorDetails } from "@/lib/errors";
import {
  useAccountModels,
  useAgentHealth,
  useDuplicateAgent,
  useRemoveAgent,
  useSetBoss,
  useUpdateAgent,
} from "@/lib/studio-queries";
import {
  type AgentDraft,
  accountsForScope,
  buildOptions,
  draftFromAgent,
  entryId,
  type OkAgent,
  PERMS,
  ROLES,
  ROOT_SCOPE,
  togglePerm,
  toggleWhere,
  updateInput,
} from "./model";

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
  onHealth: (id: string, health: HealthCheck) => void;
  onSelect: (id: string | undefined) => void;
}

/** Edits one agent file. Every change saves after a short pause, so there is no Save button. */
export function AgentEditor({ entry, agents, accounts, orgs, onHealth, onSelect }: AgentEditorProps) {
  const id = entry.agent.frontmatter.id;
  const update = useUpdateAgent();
  const [draft, setDraft] = useState<AgentDraft>(() => draftFromAgent(entry.agent));
  const [save, setSave] = useState<SaveState>({ kind: "idle" });
  const [serverWarnings, setServerWarnings] = useState<string[]>();
  const [dialog, setDialog] = useState<"duplicate" | "health" | "remove" | null>(null);

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
  const others = agents.filter((a): a is OkAgent => a.status === "ok" && entryId(a) !== id);
  const status = account ? statusInfo(account.status) : undefined;
  const bossBlock = entry.isBoss
    ? "The boss cannot be removed. Make another root agent the boss first."
    : undefined;

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-5 overflow-auto p-6">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-mono text-lg font-semibold">@{id}</h2>
        {entry.isBoss && <Badge tone="amber">Boss</Badge>}
        <SaveStatus state={save} />
        <div className="ml-auto flex flex-wrap gap-2">
          <Button onClick={() => setDialog("duplicate")}>Duplicate</Button>
          <Button onClick={() => setDialog("health")}>Health check</Button>
          {draft.scope === ROOT_SCOPE && !entry.isBoss && <MakeBoss id={id} />}
          <span title={bossBlock}>
            <Button
              onClick={() => setDialog("remove")}
              disabled={entry.isBoss}
              aria-describedby={bossBlock ? "remove-reason" : undefined}
            >
              Remove
            </Button>
          </span>
        </div>
      </div>
      {bossBlock && (
        <p id="remove-reason" className="text-sm text-fg-faint">
          {bossBlock}
        </p>
      )}
      <p className="font-mono text-xs break-all text-fg-faint">{entry.file}</p>

      {warnings.length > 0 && (
        <ul
          aria-label="Warnings"
          className="flex flex-col gap-1 rounded-md border border-amber-line bg-amber-wash px-3 py-2"
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
          className="flex flex-col gap-1 rounded-md border border-red-line bg-red-wash px-3 py-2 text-base text-red"
        >
          <p>Could not save: {save.message}</p>
          {save.details.map((d) => (
            <p key={d} className="font-mono text-sm">
              {d}
            </p>
          ))}
        </div>
      )}

      <div className="grid gap-x-6 gap-y-4 md:grid-cols-2">
        <Field label="Scope">
          {(p) => (
            <Select {...p} value={draft.scope} onChange={(e) => change({ scope: e.target.value })}>
              <option value={ROOT_SCOPE}>Root</option>
              {orgs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
              {draft.scope !== ROOT_SCOPE && !orgs.some((o) => o.id === draft.scope) && (
                <option value={draft.scope}>{draft.scope}</option>
              )}
            </Select>
          )}
        </Field>
        <Field label="Role">
          {(p) => (
            <Select
              {...p}
              value={draft.role}
              onChange={(e) => change({ role: e.target.value as AgentDraft["role"] })}
            >
              {ROLES.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </Select>
          )}
        </Field>
        <WhereField draft={draft} orgs={orgs} onChange={(where) => change({ where })} />
        <Field label="Account" className="md:col-span-1">
          {(p) => (
            <>
              <Select {...p} value={draft.account} onChange={(e) => change({ account: e.target.value })}>
                {!accountFits && <option value={draft.account}>{draft.account} (not usable here)</option>}
                {scopeAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.id}
                  </option>
                ))}
              </Select>
              {status ? (
                <span className={cn("flex items-center gap-2 text-sm", TONE_TEXT[status.tone])}>
                  <StatusDot tone={status.tone} />
                  {status.label}
                  {account?.signedInAs && (
                    <span className="font-mono text-fg-faint">{account.signedInAs}</span>
                  )}
                </span>
              ) : (
                <span className="text-sm text-red">This account does not exist.</span>
              )}
            </>
          )}
        </Field>
        <Field label="Model" warning={modelChoices.warning}>
          {(p) => (
            <Select
              {...p}
              value={draft.model ?? ""}
              onChange={(e) => change({ model: e.target.value || undefined })}
            >
              {modelChoices.options.map((o) => (
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
              onChange={(e) => change({ effort: e.target.value || undefined })}
            >
              {effortChoices.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      {models.isError && (
        <p className="text-sm text-fg-faint">
          Could not read this account's models: {describeError(models.error)}
        </p>
      )}

      {draft.model === AUTO && (
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 p-0 text-sm text-fg-faint">Models allowed for auto</legend>
          <div className="flex flex-wrap gap-x-5">
            {(models.data?.models ?? []).map((m) => (
              <label key={m.id} className="flex h-8 cursor-pointer items-center gap-2 text-base text-fg-soft">
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--color-amber)]"
                  checked={draft.models.includes(m.id)}
                  onChange={(e) =>
                    change({
                      models: e.target.checked
                        ? [...draft.models, m.id]
                        : draft.models.filter((x) => x !== m.id),
                    })
                  }
                />
                {m.name}
              </label>
            ))}
          </div>
          <p className="text-sm text-fg-faint">
            Leave all unchecked to allow every model the account offers.
          </p>
        </fieldset>
      )}

      <Field label="Instructions">
        {(p) => (
          <Textarea
            {...p}
            rows={8}
            value={draft.instructions}
            onChange={(e) => change({ instructions: e.target.value })}
          />
        )}
      </Field>

      <fieldset className="flex flex-col gap-0.5">
        <legend className="mb-1 p-0 text-sm text-fg-faint">Allowed to</legend>
        <div className="grid gap-x-6 sm:grid-cols-2">
          {PERMS.map((perm) => (
            <Switch
              key={perm.id}
              label={perm.label}
              checked={draft.perms.includes(perm.id)}
              onChange={(on) => change({ perms: togglePerm(draft.perms, perm.id as Perm, on) })}
            />
          ))}
        </div>
      </fieldset>

      <Field label="If its account hits a limit or the run breaks, use" className="max-w-[320px]">
        {(p) => (
          <Select
            {...p}
            value={draft.fallback ?? ""}
            onChange={(e) => change({ fallback: e.target.value || undefined })}
          >
            <option value="">No fallback</option>
            {others.map((a) => (
              <option key={entryId(a)} value={entryId(a)}>
                @{entryId(a)}
              </option>
            ))}
            {draft.fallback && !others.some((a) => entryId(a) === draft.fallback) && (
              <option value={draft.fallback}>{draft.fallback} (not found)</option>
            )}
          </Select>
        )}
      </Field>

      {dialog === "duplicate" && (
        <DuplicateDialog id={id} onClose={() => setDialog(null)} onDone={(newId) => onSelect(newId)} />
      )}
      {dialog === "health" && (
        <AgentHealthDialog id={id} onClose={() => setDialog(null)} onHealth={onHealth} />
      )}
      {dialog === "remove" && (
        <RemoveAgentDialog id={id} onClose={() => setDialog(null)} onDone={() => onSelect(undefined)} />
      )}
    </div>
  );
}

function SaveStatus({ state }: { state: SaveState }) {
  const text = { idle: "", saving: "Saving", saved: "Saved", error: "Not saved" }[state.kind];
  return (
    <span
      role="status"
      aria-live="polite"
      className={cn("text-sm", state.kind === "error" ? "text-red" : "text-fg-faint")}
    >
      {text}
    </span>
  );
}

function WhereField({
  draft,
  orgs,
  onChange,
}: {
  draft: AgentDraft;
  orgs: readonly OrgView[];
  onChange: (where: string[]) => void;
}) {
  const options = [{ id: "anywhere", name: "Anywhere" }, ...orgs.map((o) => ({ id: o.id, name: o.name }))];
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1 p-0 text-sm text-fg-faint">Can work in</legend>
      <div className="flex flex-wrap gap-x-4">
        {options.map((o) => (
          <label key={o.id} className="flex h-8 cursor-pointer items-center gap-2 text-base text-fg-soft">
            <input
              type="checkbox"
              className="size-4 accent-[var(--color-amber)]"
              checked={draft.where.includes(o.id)}
              onChange={() => onChange(toggleWhere(draft.where, o.id))}
            />
            {o.name}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function MakeBoss({ id }: { id: string }) {
  const boss = useSetBoss();
  return (
    <Button
      onClick={() => boss.mutate(id)}
      disabled={boss.isPending}
      title={boss.isError ? describeError(boss.error) : undefined}
    >
      Make boss
    </Button>
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
