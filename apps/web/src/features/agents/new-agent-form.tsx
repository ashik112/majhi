import { IdSchema, type Role } from "@majhi/shared";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { PageLink } from "@/components/ui/page-link";
import { Segmented } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";
import { isUsableStatus, orgLabel, statusInfo } from "@/features/accounts/model";
import { describeError } from "@/lib/errors";
import { useAccounts, useAgents, useCreateAgent, useOrgs, useTools } from "@/lib/studio-queries";
import { EmojiAvatarButton } from "./agent-emoji";
import {
  accountsForScope,
  entryId,
  newAgentFrontmatter,
  ROOT_SCOPE,
  rolesForScope,
  suggestAgentId,
} from "./model";

/** Creates an agent with sensible defaults in a group; its settings then open for the rest. */
export function NewAgentForm({
  scope,
  scopeLabel,
  presetAccount,
  onCreated,
  onCancel,
}: {
  scope: string;
  scopeLabel: string;
  presetAccount?: string | undefined;
  onCreated: (id: string) => void;
  onCancel: () => void;
}) {
  const accounts = useAccounts().data ?? [];
  const orgs = useOrgs().data ?? [];
  const tools = useTools().data ?? [];
  const agents = useAgents().data ?? [];
  const create = useCreateAgent();
  const [role, setRole] = useState<Role>(scope === ROOT_SCOPE ? "Root" : "Builder");
  const [accountPick, setAccountPick] = useState(presetAccount);
  const [idEdit, setIdEdit] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const [emoji, setEmoji] = useState<string>();

  // The scope's own accounts first, then the owner's private ones; ones that work before ones that do not.
  const usable = accountsForScope(accounts, scope).toSorted(
    (a, b) =>
      Number(b.org === scope) - Number(a.org === scope) ||
      Number(isUsableStatus(b.status)) - Number(isUsableStatus(a.status)),
  );
  const account = usable.find((a) => a.id === accountPick) ?? usable[0];
  const suggested = suggestAgentId(scope, account?.tool ?? "agent", agents.map(entryId));
  const id = idEdit ?? suggested;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!account) return setProblem("Add an account for this group first");
    const parsed = IdSchema.safeParse(id);
    if (!parsed.success) return setProblem(parsed.error.issues[0]?.message ?? "Invalid id");
    setProblem(undefined);
    create.mutate(
      {
        id: parsed.data,
        frontmatter: { ...newAgentFrontmatter(scope, role, account.id), ...(emoji ? { emoji } : {}) },
        instructions: "",
      },
      { onSuccess: () => onCreated(parsed.data), onError: (e) => setProblem(describeError(e)) },
    );
  }

  return (
    <form onSubmit={submit} aria-label="New agent" className="flex max-w-[560px] flex-col gap-5 pt-5">
      <div className="flex flex-col gap-1">
        <h2 className="text-md font-semibold">New agent in {scopeLabel}</h2>
        <p className="text-base text-fg-muted">
          Pick a role and an account. You tune the rest after it exists.
        </p>
      </div>
      <div className="flex items-end gap-3">
        <EmojiAvatarButton
          id={id || "agent"}
          role={role}
          emoji={emoji}
          size={34}
          onChange={(value, close) => {
            setEmoji(value ?? undefined);
            close();
          }}
        />
        <Field label="Agent id" className="flex-1">
          {(p) => (
            <Input
              {...p}
              className="font-mono"
              value={id}
              onChange={(e) => setIdEdit(e.target.value)}
              autoFocus
            />
          )}
        </Field>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-sm text-fg-faint">Role</span>
        <Segmented
          label="Role"
          value={role}
          segments={rolesForScope(scope, role).map((r) => ({ value: r, label: r }))}
          onChange={setRole}
          className="self-start"
        />
      </div>
      {usable.length === 0 ? (
        <p role="alert" className="text-base text-red">
          No account fits this group.{" "}
          <PageLink page="accounts" className="underline underline-offset-2 hover:text-fg">
            Add one in Accounts
          </PageLink>
          .
        </p>
      ) : (
        <Field label="Account">
          {(p) => (
            <Select {...p} value={account?.id ?? ""} onChange={(e) => setAccountPick(e.target.value)}>
              {usable.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.id} · {tools.find((t) => t.id === a.tool)?.name ?? a.tool} · {orgLabel(a.org, orgs).name}{" "}
                  · {statusInfo(a.status).label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
      {problem && (
        <p role="alert" className="text-base text-red text-pretty">
          {problem}
        </p>
      )}
      <div className="flex gap-2">
        <Button type="submit" variant="primary" disabled={create.isPending || !account}>
          Create agent
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
