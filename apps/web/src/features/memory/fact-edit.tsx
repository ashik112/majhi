import type { Fact } from "@majhi/shared";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { Select, Textarea } from "@/components/ui/select";
import { describeError } from "@/lib/errors";
import { useEditFact } from "@/lib/memory-queries";
import { type ProjectOrgs, scopeOptions } from "./model";

/** Edit a fact's words or move it to another scope. The status stays; the log says what changed. */
export function EditFactDialog({
  fact,
  orgNames,
  projectOrgs,
  onClose,
}: {
  fact: Fact;
  orgNames: ReadonlyMap<string, string>;
  projectOrgs: ProjectOrgs;
  onClose: () => void;
}) {
  const edit = useEditFact();
  const [text, setText] = useState(fact.text);
  const [scope, setScope] = useState(fact.scope);
  const [problem, setProblem] = useState<string>();
  const options = scopeOptions(orgNames, projectOrgs);
  // A scope that is no longer registered still shows, so the select never lies about where it is.
  const shown = options.some((o) => o.scope === fact.scope)
    ? options
    : [{ scope: fact.scope, label: fact.scope }, ...options];
  const changed = text.trim() !== fact.text || scope !== fact.scope;

  return (
    <Modal label="Edit fact" onClose={onClose} className="w-[520px]">
      <form
        className="flex flex-col gap-4 p-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (!changed) return onClose();
          edit.mutate(
            {
              id: fact.id,
              ...(text.trim() === fact.text ? {} : { text: text.trim() }),
              ...(scope === fact.scope ? {} : { scope }),
            },
            { onSuccess: onClose, onError: (e) => setProblem(describeError(e)) },
          );
        }}
      >
        <h2 className="text-md font-semibold">Edit fact</h2>
        <Field label="Words">
          {(props) => (
            <Textarea
              {...props}
              rows={fact.kind === "playbook" ? 6 : 3}
              className="font-sans"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          )}
        </Field>
        <Field
          label="Where it holds"
          hint="Agents of that workspace or project get it. Other workspaces never do."
        >
          {(props) => (
            <Select {...props} value={scope} onChange={(e) => setScope(e.target.value)}>
              {shown.map((o) => (
                <option key={o.scope} value={o.scope}>
                  {o.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {problem && (
          <p
            role="alert"
            className="rounded-md border border-red-line bg-red-wash px-3 py-2 text-base text-red text-pretty"
          >
            {problem}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={edit.isPending || text.trim().length < 3}>
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}
