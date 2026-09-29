import { IdSchema, type Role } from "@majhi/shared";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { statusInfo } from "@/features/accounts/model";
import { describeError } from "@/lib/errors";
import { useAccounts, useAgents, useCreateAgent, useOrgs } from "@/lib/studio-queries";
import { accountsForScope, entryId, newAgentFrontmatter, ROLES, ROOT_SCOPE, suggestAgentId } from "./model";

/** Creates an agent with sensible defaults; the editor then opens for the rest. */
export function NewAgentForm({
  scope: initialScope,
  presetAccount,
  onCreated,
  onCancel,
}: {
  scope: string;
  presetAccount?: string | undefined;
  onCreated: (id: string) => void;
  onCancel: () => void;
}) {
  const accounts = useAccounts().data ?? [];
  const orgs = useOrgs().data ?? [];
  const agents = useAgents().data ?? [];
  const create = useCreateAgent();
  const [scope, setScope] = useState(initialScope);
  const [role, setRole] = useState<Role>(initialScope === ROOT_SCOPE ? "Root" : "Builder");
  const [accountPick, setAccountPick] = useState(presetAccount);
  const [idEdit, setIdEdit] = useState<string>();
  const [problem, setProblem] = useState<string>();

  const usable = accountsForScope(accounts, scope);
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
    <form onSubmit={submit} aria-label="New agent" className="flex max-w-[520px] flex-col gap-4 p-6">
      <h2 className="text-md font-semibold">New agent</h2>
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
      <Field label="Scope">
        {(p) => (
          <Select
            {...p}
            value={scope}
            onChange={(e) => {
              setScope(e.target.value);
              setIdEdit(undefined);
            }}
          >
            <option value={ROOT_SCOPE}>Root</option>
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Role">
        {(p) => (
          <Select {...p} value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {ROLES.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </Select>
        )}
      </Field>
      <Field
        label="Account"
        {...(usable.length === 0
          ? { error: "No account fits this scope. Add one in the Accounts tab." }
          : {})}
      >
        {(p) => (
          <Select
            {...p}
            value={account?.id ?? ""}
            onChange={(e) => setAccountPick(e.target.value)}
            disabled={usable.length === 0}
          >
            {usable.map((a) => (
              <option key={a.id} value={a.id}>
                {a.id} ({statusInfo(a.status).label.toLowerCase()})
              </option>
            ))}
          </Select>
        )}
      </Field>
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
