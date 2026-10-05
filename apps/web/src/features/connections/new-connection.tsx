import {
  activeLists,
  type ConnectionType,
  connectionType,
  GLOBAL_CONNECTIONS,
  type OrgView,
  PRIVATE,
} from "@majhi/shared";
import { ArrowLeft } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { DetailPane } from "@/components/ui/list-detail";
import { Textarea } from "@/components/ui/select";
import { useConnectionCommand } from "@/lib/connection-queries";
import { describeError, errorDetails } from "@/lib/errors";
import { ConnectionFields } from "./connection-fields";
import { createInput, emptyDraft, entryNameProblem, filledFields } from "./model";
import { ScopePicker } from "./scope-picker";

/** The page's glass frame with the workspace picker, or a plain box inside the Add dialog. */
function Frame({ bare, head, children }: { bare: boolean; head: ReactNode; children: ReactNode }) {
  return bare ? (
    <div>{children}</div>
  ) : (
    <DetailPane label="Custom setup" head={head}>
      {children}
    </DetailPane>
  );
}

/** A new connection: its org, type, name and description, and the text values. Secrets and files come next. */
export function NewConnection({
  orgs,
  defaultOrg,
  initialType = "mcp",
  bare = false,
  onCreated,
  onClose,
}: {
  initialType?: ConnectionType;
  /** Inside the Add dialog: no frame and no workspace picker, the dialog's own picker decides. */
  bare?: boolean;
  orgs: readonly OrgView[];
  defaultOrg: string | undefined;
  onCreated: (id: string) => void;
  onClose: () => void;
}) {
  const create = useConnectionCommand("connections.create");
  const [chosen, setOrg] = useState(defaultOrg ?? PRIVATE);
  const org = bare ? (defaultOrg ?? PRIVATE) : chosen;
  const type = initialType;
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [draft, setDraft] = useState(() => emptyDraft(initialType));
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
    <Frame
      bare={bare}
      head={<ScopePicker orgs={orgs} value={org} onChange={setOrg} disabled={create.isPending} />}
    >
      <form
        className={bare ? "flex max-w-[640px] flex-col gap-4" : "flex max-w-[640px] flex-col gap-4 pt-5"}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="flex items-center gap-3">
          <h2 className="text-md font-semibold">{def.label}</h2>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            aria-label="Back to services"
            disabled={create.isPending}
            onClick={onClose}
          >
            <ArrowLeft aria-hidden="true" />
            Back to services
          </Button>
        </div>
        <p className="text-sm text-fg-faint text-pretty">{def.summary}.</p>
        <div className="grid gap-3 @[560px]:grid-cols-2">
          <Field label="Name">
            {(p) => (
              <Input
                {...p}
                value={name}
                maxLength={80}
                placeholder={
                  type === "kubectl"
                    ? "Acme production"
                    : type === "ssh"
                      ? "Acme server"
                      : type === "host"
                        ? "Acme local stack"
                        : "Acme service"
                }
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
              placeholder={
                type === "kubectl"
                  ? "Read-only access to the production cluster."
                  : "What this connection lets agents do."
              }
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
            {create.isPending
              ? "Creating"
              : org === GLOBAL_CONNECTIONS
                ? "Add Global connection"
                : "Add connection"}
          </Button>
          <span className="text-sm text-fg-faint">
            {type === "host"
              ? "majhi opens each port when you add it. Agents get it only if every port answers."
              : "Next, add the credentials and test the connection."}
          </span>
        </div>
      </form>
    </Frame>
  );
}
