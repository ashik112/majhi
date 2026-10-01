import {
  activeLists,
  CONNECTION_TYPES,
  type ConnectionType,
  connectionType,
  type OrgView,
} from "@majhi/shared";
import { X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ChoiceGroup } from "@/components/ui/choice-group";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { DetailPane } from "@/components/ui/list-detail";
import { Select, Textarea } from "@/components/ui/select";
import { useConnectionCommand } from "@/lib/connection-queries";
import { describeError, errorDetails } from "@/lib/errors";
import { ConnectionFields } from "./connection-fields";
import { createInput, emptyDraft, entryNameProblem, filledFields } from "./model";

/** A new connection: its org, type, name and description, and the text values. Secrets and files come next. */
export function NewConnection({
  orgs,
  defaultOrg,
  onCreated,
  onClose,
}: {
  orgs: readonly OrgView[];
  defaultOrg: string | undefined;
  onCreated: (id: string) => void;
  onClose: () => void;
}) {
  const create = useConnectionCommand("connections.create");
  const [org, setOrg] = useState(defaultOrg ?? orgs[0]?.id ?? "");
  const [type, setType] = useState<ConnectionType>("kubectl");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [draft, setDraft] = useState(() => emptyDraft("kubectl"));
  const def = connectionType(type);
  const lists = activeLists(type, filledFields(draft));
  const badName = lists.some((l) =>
    draft.lists[l.key].some((e) => entryNameProblem(l.names, e, draft.lists[l.key]) !== undefined),
  );
  const ready = org !== "" && name.trim() !== "" && !badName && !create.isPending;
  const submit = () => {
    if (!ready) return;
    create.mutate(createInput({ org, type, name, description, draft, lists: lists.map((l) => l.key) }), {
      onSuccess: (view) => onCreated(view.id),
    });
  };
  return (
    <DetailPane label="New connection">
      <form
        className="flex max-w-[640px] flex-col gap-4 pt-5"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="flex items-center gap-3">
          <h2 className="text-md font-semibold">New connection</h2>
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto"
            aria-label="Close new connection"
            title="Close"
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
        <ChoiceGroup
          label="Type"
          value={type}
          choices={CONNECTION_TYPES.map((t) => ({ value: t.type, label: t.label }))}
          onChange={(next) => {
            setType(next);
            setDraft(emptyDraft(next));
          }}
        />
        <p className="-mt-2 text-sm text-fg-faint text-pretty">{def.summary}.</p>
        <div className="grid gap-3 @[560px]:grid-cols-2">
          <Field label="Org">
            {(p) => (
              <Select {...p} value={org} onChange={(e) => setOrg(e.target.value)}>
                {orgs.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Name">
            {(p) => (
              <Input
                {...p}
                value={name}
                maxLength={80}
                placeholder="Acme prod cluster"
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </Field>
        </div>
        <Field label="Description" hint="What agents see: what it reaches and how to use it. Never a secret.">
          {(p) => (
            <Textarea
              {...p}
              rows={2}
              maxLength={2000}
              className="font-sans"
              value={description}
              placeholder="Read-only viewer on the prod cluster. The api runs in namespace api."
              onChange={(e) => setDescription(e.target.value)}
            />
          )}
        </Field>
        <ConnectionFields type={type} draft={draft} onChange={setDraft} />
        {create.isError && (
          <div role="alert" className="flex flex-col gap-1 text-sm text-red">
            <p className="text-pretty">Could not create it: {describeError(create.error)}</p>
            {errorDetails(create.error).map((d) => (
              <p key={d} className="font-mono">
                {d}
              </p>
            ))}
          </div>
        )}
        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary" disabled={!ready}>
            {create.isPending ? "Creating" : "Create connection"}
          </Button>
          <span className="text-sm text-fg-faint">Secrets and files are set right after.</span>
        </div>
      </form>
    </DetailPane>
  );
}
