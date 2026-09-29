import type { HealthCheck } from "@majhi/shared";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { describeError } from "@/lib/errors";
import { useAccounts, useAgents, useOrgs, useRemoveAgent } from "@/lib/studio-queries";
import { AgentEditor } from "./agent-editor";
import { AgentList } from "./agent-list";
import { entryId, groupAgents, type InvalidAgent, scopeForAccount } from "./model";
import { NewAgentForm } from "./new-agent-form";

export interface AgentsSearch {
  /** The agent open in the editor. */
  agent?: string | undefined;
  /** Open "New agent" with this account chosen. */
  account?: string | undefined;
}

export function AgentsTab({
  search,
  onSearch,
}: {
  search: AgentsSearch;
  onSearch: (search: AgentsSearch) => void;
}) {
  const agents = useAgents();
  const accounts = useAccounts();
  const orgs = useOrgs();
  const [creating, setCreating] = useState<{ scope: string } | null>(null);
  const [health, setHealth] = useState<ReadonlyMap<string, HealthCheck>>(new Map());

  const entries = agents.data ?? [];
  const accountList = accounts.data ?? [];
  const groups = groupAgents(entries, orgs.data ?? []);
  const presetAccount = search.account ? accountList.find((a) => a.id === search.account) : undefined;
  const newScope = creating?.scope ?? (presetAccount ? scopeForAccount(presetAccount) : undefined);
  const selected = entries.find((e) => entryId(e) === search.agent);

  if (agents.isError) {
    return (
      <p role="alert" className="p-6 text-base text-red">
        Could not load agents: {describeError(agents.error)}
      </p>
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      <AgentList
        groups={groups}
        accounts={accountList}
        health={health}
        selected={newScope === undefined ? search.agent : undefined}
        onSelect={(id) => {
          setCreating(null);
          onSearch({ agent: id });
        }}
        onNew={(scope) => {
          setCreating({ scope });
          onSearch({});
        }}
      />
      <div className="flex min-w-0 flex-1 flex-col overflow-auto">
        {newScope !== undefined ? (
          <NewAgentForm
            key={`${newScope}:${search.account ?? ""}`}
            scope={newScope}
            presetAccount={search.account}
            onCreated={(id) => {
              setCreating(null);
              onSearch({ agent: id });
            }}
            onCancel={() => {
              setCreating(null);
              onSearch({});
            }}
          />
        ) : selected?.status === "ok" ? (
          <AgentEditor
            key={entryId(selected)}
            entry={selected}
            agents={entries}
            accounts={accountList}
            orgs={orgs.data ?? []}
            onHealth={(id, h) => setHealth((prev) => new Map(prev).set(id, h))}
            onSelect={(id) => onSearch({ agent: id })}
          />
        ) : selected ? (
          <InvalidAgentPanel entry={selected} onRemoved={() => onSearch({})} />
        ) : (
          <div className="p-6 text-base text-fg-muted">
            {agents.isSuccess && entries.length === 0
              ? "No agents yet. Use New in a group to create one."
              : "Pick an agent to edit it. Changes save as you type."}
          </div>
        )}
      </div>
    </div>
  );
}

/** A file in ~/.majhi/agents that did not load: shows every error so the owner can fix the file. */
function InvalidAgentPanel({ entry, onRemoved }: { entry: InvalidAgent; onRemoved: () => void }) {
  const remove = useRemoveAgent();
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="flex max-w-[720px] flex-col gap-4 p-6">
      <h2 className="font-mono text-lg font-semibold">@{entry.id}</h2>
      <div
        role="alert"
        className="flex flex-col gap-2 rounded-md border border-red-line bg-red-wash px-4 py-3"
      >
        <p className="text-base font-medium text-red">This file has errors and did not load.</p>
        <p className="font-mono text-sm break-all text-fg-muted">{entry.file}</p>
        <ul aria-label="Errors" className="flex flex-col gap-1">
          {entry.errors.map((error) => (
            <li key={error} className="font-mono text-sm break-words text-red">
              {error}
            </li>
          ))}
        </ul>
      </div>
      <p className="text-base text-fg-muted text-pretty">
        Fix the file in an editor. It reloads when you save it.
      </p>
      <div>
        <Button onClick={() => setConfirm(true)}>Remove file</Button>
      </div>
      {confirm && (
        <ConfirmDialog
          title={`Remove ${entry.id}?`}
          body="This deletes the file."
          confirmLabel="Remove file"
          busy={remove.isPending}
          error={remove.isError ? describeError(remove.error) : undefined}
          onCancel={() => setConfirm(false)}
          onConfirm={() =>
            remove.mutate(entry.id, {
              onSuccess: () => {
                setConfirm(false);
                onRemoved();
              },
            })
          }
        />
      )}
    </div>
  );
}
