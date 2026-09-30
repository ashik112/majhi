import {
  type AccountView,
  IdSchema,
  type OrgView,
  PRIVATE,
  type ToolInfo,
  type UsageTotals,
} from "@majhi/shared";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { OrgBadge } from "@/components/ui/org-badge";
import { PageLink } from "@/components/ui/page-link";
import { SectionLabel } from "@/components/ui/section-label";
import { Select } from "@/components/ui/select";
import { Dot, toneText } from "@/components/ui/status-dot";
import { ORG_COLORS, statusInfo } from "@/features/accounts/model";
import { CostText } from "@/features/usage/cost";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { badgeLetters, plural } from "@/lib/format";
import { HOST_LABEL } from "@/lib/hosts";
import { useRenameOrg, useSaveSecret, useUpdateOrg } from "@/lib/studio-queries";
import {
  checkOrgDraft,
  draftFromOrg,
  identityLabel,
  MERGE_LABEL,
  MR_HOSTS,
  type OrgDraft,
  type OrgErrors,
} from "./model";
import { MrSettings } from "./mr-settings";

export const CARD = "flex flex-col gap-4 rounded-xl border border-line-strong bg-raised p-[18px]";

/** One org: its accounts, a way into its agents, and its settings, editable in place. */
export function OrgCard({
  org,
  accounts,
  tools,
  openTasks,
  month,
  onAddAccount,
  highlighted = false,
}: {
  org: OrgView;
  accounts: readonly AccountView[];
  tools: readonly ToolInfo[] | undefined;
  openTasks: number;
  /** Tokens and cost this month; undefined while it loads. */
  month: UsageTotals | undefined;
  onAddAccount: () => void;
  /** This is the org the sidebar filter is set to. */
  highlighted?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <section
      aria-label={org.name}
      aria-current={highlighted ? "true" : undefined}
      className={cn(CARD, highlighted && "border-accent-line")}
    >
      <div className="flex items-center gap-3">
        <OrgBadge label={badgeLetters(org.key)} color={org.color} className="size-8 rounded-lg text-xs" />
        <h2 className="min-w-0 truncate text-lg font-semibold">{org.name}</h2>
        <span className="ml-auto flex shrink-0 flex-col items-end text-sm text-fg-muted tabular-nums">
          <span>{plural(openTasks, "open task")}</span>
          {month && (
            <span className="flex items-baseline gap-1 text-xs text-fg-faint">
              <CostText totals={month} className="text-fg-soft" />
              this month
            </span>
          )}
        </span>
      </div>
      <AccountList accounts={accounts} tools={tools} orgName={org.name} onAdd={onAddAccount} />
      <Button asChild size="lg" className="border border-line-bright bg-card hover:bg-selected">
        <PageLink page="agents" search={{ org: org.id }}>
          Manage {org.name} agents ({org.agentCount})
        </PageLink>
      </Button>
      {editing ? (
        <OrgForm org={org} onDone={() => setEditing(false)} />
      ) : (
        <OrgFacts org={org} onEdit={() => setEditing(true)} />
      )}
    </section>
  );
}

function AccountList({
  accounts,
  tools,
  orgName,
  onAdd,
}: {
  accounts: readonly AccountView[];
  tools: readonly ToolInfo[] | undefined;
  orgName: string;
  onAdd: () => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center">
        <SectionLabel>Accounts</SectionLabel>
        <Button
          className="ml-auto -my-1 h-6 px-2 text-xs"
          variant="ghost"
          size="sm"
          onClick={onAdd}
          aria-label={`Add account to ${orgName}`}
        >
          Add account
        </Button>
      </div>
      {accounts.length === 0 ? (
        <p className="text-sm text-fg-faint">No accounts yet.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {accounts.map((account) => {
            const status = statusInfo(account.status);
            return (
              <li key={account.id} className="flex items-center gap-2 text-sm">
                <Dot tone={status.tone} />
                <span className="sr-only">{status.label}: </span>
                <PageLink
                  page="accounts"
                  search={{ account: account.id }}
                  className="rounded-xs font-mono hover:underline"
                >
                  {account.id}
                </PageLink>
                <span
                  className={cn(
                    "ml-auto truncate text-fg-faint",
                    account.status === "needs-login" && toneText("red"),
                  )}
                >
                  {tools?.find((t) => t.id === account.tool)?.name ?? account.tool} · {orgName}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function OrgFacts({ org, onEdit }: { org: OrgView; onEdit: () => void }) {
  const identity = identityLabel(org);
  const mrHosts = MR_HOSTS.filter((h) => org.mrTokens?.[h] !== undefined);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center">
        <SectionLabel>Settings</SectionLabel>
        <Button
          className="ml-auto -my-1 h-6 px-2 text-xs"
          variant="ghost"
          size="sm"
          onClick={onEdit}
          aria-label={`Edit ${org.name}`}
        >
          Edit
        </Button>
      </div>
      <dl className="grid grid-cols-[92px_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
        <Fact label="Task key">
          <span className="font-mono">{org.key}</span>
        </Fact>
        <Fact label="Base branch">
          {org.base ? (
            <span className="font-mono">{org.base}</span>
          ) : (
            <span className="text-fg-faint">Repo default</span>
          )}
        </Fact>
        <Fact label="Color">
          <span className="inline-flex items-center gap-2">
            <span
              aria-hidden="true"
              className="size-2.5 rounded-xs"
              style={{ backgroundColor: org.color ?? "#8a8f99" }}
            />
            <span className="font-mono text-fg-muted">{org.color ?? "none"}</span>
          </span>
        </Fact>
        <Fact label="Merge requests">
          <span>{MERGE_LABEL[org.merge]}</span>
          {mrHosts.length > 0 && (
            <span className="block text-xs text-fg-faint">
              Tokens set: {mrHosts.map((h) => HOST_LABEL[h]).join(", ")}
            </span>
          )}
        </Fact>
        <Fact label="Commits as">
          {identity ? (
            <span className="break-words">{identity}</span>
          ) : (
            <span className="text-fg-faint">Not set</span>
          )}
        </Fact>
      </dl>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-fg-faint">{label}</dt>
      <dd className="m-0 min-w-0 text-fg-soft">{children}</dd>
    </>
  );
}

function OrgForm({ org, onDone }: { org: OrgView; onDone: () => void }) {
  const update = useUpdateOrg();
  const rename = useRenameOrg();
  const saveSecret = useSaveSecret();
  const [orgId, setOrgId] = useState(org.id);
  const [draft, setDraft] = useState<OrgDraft>(() => draftFromOrg(org));
  const [errors, setErrors] = useState<OrgErrors>({});
  const [failure, setFailure] = useState<string>();
  const set = (patch: Partial<OrgDraft>) => setDraft((d) => ({ ...d, ...patch }));

  async function submit() {
    setFailure(undefined);
    // A token typed for a host becomes a secret first; the org keeps only its reference.
    let mrTokens = draft.mrTokens;
    try {
      for (const host of MR_HOSTS) {
        const value = draft.newTokens[host].trim();
        if (value === "") continue;
        const saved = await saveSecret.mutateAsync({ value, label: `${org.name} ${HOST_LABEL[host]} token` });
        mrTokens = { ...mrTokens, [host]: saved.ref };
      }
    } catch (e) {
      setFailure(describeError(e));
      return;
    }
    // The typed values are spent: a retry after a failed save must not save them again.
    const next = { ...draft, mrTokens, newTokens: { github: "", gitlab: "", bitbucket: "" } };
    setDraft(next);
    const check = checkOrgDraft(org, next);
    if (!check.ok) return setErrors(check.errors);
    const nextId = orgId.trim();
    if (nextId !== org.id && !IdSchema.safeParse(nextId).success) {
      setFailure("Org id: use lowercase letters, digits and dashes");
      return;
    }
    setErrors({});
    const save = (id: string) => {
      if (!check.input) return onDone();
      update.mutate(
        { ...check.input, id },
        { onSuccess: onDone, onError: (e) => setFailure(describeError(e)) },
      );
    };
    if (nextId === org.id) return save(org.id);
    rename.mutate(
      { id: org.id, newId: nextId },
      { onSuccess: () => save(nextId), onError: (e) => setFailure(describeError(e)) },
    );
  }

  const colors =
    draft.color && !ORG_COLORS.some((c) => c === draft.color) ? [...ORG_COLORS, draft.color] : ORG_COLORS;

  return (
    <form
      aria-label={`Edit ${org.name}`}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="flex flex-col gap-3 rounded-lg border border-line-bright bg-card p-3"
    >
      <Field label="Name" error={errors.name}>
        {(p) => <Input {...p} value={draft.name} onChange={(e) => set({ name: e.target.value })} />}
      </Field>
      <Field
        label="Org id"
        hint={
          org.id === PRIVATE
            ? "The built-in org keeps its id."
            : "Renaming updates its agents, accounts and projects. Task keys stay."
        }
      >
        {(p) => (
          <Input
            {...p}
            className="font-mono"
            disabled={org.id === PRIVATE}
            value={orgId}
            onChange={(e) => setOrgId(e.target.value)}
          />
        )}
      </Field>
      <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
        <legend className="mb-1.5 p-0 text-sm text-fg-faint">Color</legend>
        <div className="flex gap-2">
          {colors.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`Color ${c}`}
              aria-pressed={draft.color === c}
              onClick={() => set({ color: c })}
              style={{ backgroundColor: c }}
              className={cn(
                "size-6 cursor-pointer rounded-md border-2 border-transparent transition-transform hover:scale-110",
                draft.color === c && "border-fg",
              )}
            />
          ))}
        </div>
        {errors.color && <p className="text-sm text-red">{errors.color}</p>}
      </fieldset>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Task key" error={errors.key} hint="Like GLX for GLX-420.">
          {(p) => (
            <Input
              {...p}
              className="font-mono uppercase"
              value={draft.key}
              onChange={(e) => set({ key: e.target.value })}
            />
          )}
        </Field>
        <Field label="Base branch" hint="Blank uses the repo's default.">
          {(p) => (
            <Input
              {...p}
              className="font-mono"
              placeholder="main"
              value={draft.base}
              onChange={(e) => set({ base: e.target.value })}
            />
          )}
        </Field>
      </div>
      <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
        <legend className="mb-1.5 p-0 text-sm text-fg-faint">Commit identity</legend>
        <Field label="Commit name" error={errors.identityName}>
          {(p) => (
            <Input
              {...p}
              placeholder="Your name"
              value={draft.identityName}
              onChange={(e) => set({ identityName: e.target.value })}
            />
          )}
        </Field>
        <Field label="Commit email" error={errors.identityEmail}>
          {(p) => (
            <Input
              {...p}
              type="email"
              placeholder="you@company.com"
              value={draft.identityEmail}
              onChange={(e) => set({ identityEmail: e.target.value })}
            />
          )}
        </Field>
      </fieldset>
      <Field
        label="Resume interrupted work"
        hint="After a restart, lost internet or sleep, without you clicking."
      >
        {(p) => (
          <Select
            {...p}
            value={draft.resume}
            onChange={(e) => set({ resume: e.target.value as OrgDraft["resume"] })}
          >
            <option value="default">majhi's setting</option>
            <option value="on">On its own</option>
            <option value="off">Wait for me</option>
          </Select>
        )}
      </Field>
      <MrSettings draft={draft} error={errors.mrTokens} onChange={set} />
      {failure && (
        <p role="alert" className="text-sm text-red text-pretty">
          {failure}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          type="submit"
          variant="primary"
          disabled={update.isPending || rename.isPending || saveSecret.isPending}
        >
          {update.isPending || rename.isPending || saveSecret.isPending ? "Saving" : "Save"}
        </Button>
        <Button onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}
