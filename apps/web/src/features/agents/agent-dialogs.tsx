import type { HealthCheck } from "@majhi/shared";
import { IdSchema } from "@majhi/shared";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { HealthDialog } from "@/features/accounts/health-dialog";
import { describeError } from "@/lib/errors";
import { useAgentHealth, useDuplicateAgent, useRemoveAgent, useRenameAgent } from "@/lib/studio-queries";

/** The dialogs behind an agent's Health check button and its more menu. */

export function DuplicateDialog({
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

export function RenameDialog({
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

export function AgentHealthDialog({
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

export function RemoveAgentDialog({
  id,
  onClose,
  onDone,
}: {
  id: string;
  onClose: () => void;
  onDone: () => void;
}) {
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
