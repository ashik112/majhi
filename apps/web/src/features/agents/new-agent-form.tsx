import { IdSchema, type Role } from "@majhi/shared";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { ChoiceChip } from "@/components/ui/choice-chip";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { PageLink } from "@/components/ui/page-link";
import { isUsableStatus, orgLabel, statusInfo } from "@/features/accounts/model";
import { describeError } from "@/lib/errors";
import { useAccounts, useAgents, useCreateAgent, useOrgs, useTools } from "@/lib/studio-queries";
import {
  accountsForScope,
  entryId,
  newAgentFrontmatter,
  ROOT_SCOPE,
  rolesForScope,
  suggestAgentId,
} from "./model";

/** Creates an agent with sensible defaults in the scope of the open tab; the editor then opens for the rest. */
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
    if (!account) return setProblem("Add an account for this scope first");
    const parsed = IdSchema.safeParse(id);
    if (!parsed.success) return setProblem(parsed.error.issues[0]?.message ?? "Invalid id");
    setProblem(undefined);
    create.mutate(
      { id: parsed.data, frontmatter: newAgentFrontmatter(scope, role, account.id), instructions: "" },
      { onSuccess: () => onCreated(parsed.data), onError: (e) => setProblem(describeError(e)) },
    );
  }

  return (
    <form
      onSubmit={submit}
      aria-label="New agent"
      className="flex min-w-0 max-w-[560px] flex-1 flex-col gap-5 px-7 pt-[18px] pb-7"
    >
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">New agent in {scopeLabel}</h2>
        <p className="text-base text-fg-muted">
          Pick a role and an account. You tune everything else after it exists.
        </p>
      </div>
      <Field label="Agent id">
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
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-2 p-0 text-sm text-fg-faint">Role</legend>
        <div className="flex flex-wrap gap-1.5">
          {rolesForScope(scope, role).map((r) => (
            <ChoiceChip key={r} pressed={role === r} onClick={() => setRole(r)} className="h-[34px]">
              {r}
            </ChoiceChip>
          ))}
        </div>
      </fieldset>
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-2 p-0 text-sm text-fg-faint">Account</legend>
        {usable.length === 0 ? (
          <p role="alert" className="text-base text-red">
            No account fits this scope.{" "}
            <PageLink page="accounts" className="underline underline-offset-2 hover:text-fg">
              Add one in Accounts
            </PageLink>
            .
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {usable.map((a) => (
              <ChoiceChip
                key={a.id}
                pressed={account?.id === a.id}
                aria-label={`${a.id}, ${statusInfo(a.status).label.toLowerCase()}`}
                className="min-h-11 flex-col items-start gap-px px-2.5 py-1"
                onClick={() => setAccountPick(a.id)}
              >
                <span className="font-mono text-sm">{a.id}</span>
                <span className="text-[0.625rem] leading-4 font-normal text-fg-faint">
                  {tools.find((t) => t.id === a.tool)?.name ?? a.tool} · {orgLabel(a.org, orgs).name}
                </span>
              </ChoiceChip>
            ))}
          </div>
        )}
      </fieldset>
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
