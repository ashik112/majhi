import { IdSchema } from "@majhi/shared";
import { type KeyboardEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useCaptainRules } from "@/lib/captain-queries";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { useCreateOrg } from "@/lib/studio-queries";
import { ORG_COLORS, orgColorName, orgIdFromName, suggestOrgColor } from "./model";

/**
 * Inline "New org" form: a name, an id derived from it (editable) and a color. It sits inside the
 * add-account form, and forms cannot nest (the browser would submit the inner one natively), so it
 * is a plain group that submits on Enter and on its button.
 */
export function NewOrgForm({
  orgCount,
  privateAccounts,
  onCreated,
  onCancel,
  className,
}: {
  orgCount: number;
  /** Private accounts the owner could let pay for the new workspace's captain. Given: the form asks. */
  privateAccounts?: readonly string[];
  onCreated: (orgId: string) => void;
  onCancel: () => void;
  className?: string;
}) {
  const create = useCreateOrg();
  const rules = useCaptainRules();
  const [pays, setPays] = useState("");
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [idEdited, setIdEdited] = useState(false);
  const [color, setColor] = useState<string>(() => suggestOrgColor(orgCount));
  const [problem, setProblem] = useState<string>();

  const shownId = idEdited ? id : orgIdFromName(name);

  function submit() {
    if (name.trim() === "") return setProblem("Give the workspace a name");
    const parsed = IdSchema.safeParse(shownId);
    if (!parsed.success) return setProblem(parsed.error.issues[0]?.message ?? "Invalid id");
    setProblem(undefined);
    create.mutate(
      { id: parsed.data, name: name.trim(), color },
      {
        onSuccess: (org) => {
          if (pays === "") return onCreated(org.id);
          rules.mutate(
            {
              input: { orgs: { [org.id]: { account: pays } } },
              reason: `Owner chose who pays for ${org.name}`,
            },
            { onSettled: () => onCreated(org.id) },
          );
        },
        onError: (e) => setProblem(describeError(e)),
      },
    );
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key !== "Enter" || !(event.target instanceof HTMLInputElement)) return;
    if (event.target.type === "radio") return;
    // Enter here must not reach the account form around this group.
    event.preventDefault();
    submit();
  }

  return (
    // biome-ignore lint/a11y/useSemanticElements: a real <form> cannot nest in the add-account form
    <div
      role="form"
      onKeyDown={onKeyDown}
      aria-label="New workspace"
      className={cn("flex flex-col gap-3 rounded-md border border-line-strong bg-sunken p-3", className)}
    >
      <Field label="Workspace name">
        {(p) => (
          <Input {...p} value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme" autoFocus />
        )}
      </Field>
      <Field label="Workspace id" hint="Used in file names and config. Lowercase letters, digits and dashes.">
        {(p) => (
          <Input
            {...p}
            className="font-mono"
            value={shownId}
            onChange={(e) => {
              setIdEdited(true);
              setId(e.target.value);
            }}
          />
        )}
      </Field>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1.5 p-0 text-sm text-fg-faint">Color</legend>
        <div className="flex gap-2">
          {ORG_COLORS.map((c) => (
            <label key={c} className="relative">
              <input
                type="radio"
                name="org-color"
                value={c}
                checked={color === c}
                onChange={() => setColor(c)}
                aria-label={orgColorName(c)}
                className="peer absolute inset-0 size-full cursor-pointer opacity-0"
              />
              <span
                style={{ backgroundColor: c }}
                className={cn(
                  "block size-6 rounded-full border-2 border-transparent",
                  "peer-checked:border-fg peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-blue",
                )}
              />
            </label>
          ))}
        </div>
      </fieldset>
      {privateAccounts !== undefined && privateAccounts.length > 0 && (
        <Field label="Pays for the captain here">
          {(p) => (
            <Select {...p} value={pays} onChange={(e) => setPays(e.target.value)} className="h-8 text-sm">
              <option value="">Add one later</option>
              {privateAccounts.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
      {problem && (
        <p role="alert" className="text-sm text-red">
          {problem}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" onClick={submit} disabled={create.isPending}>
          Create workspace
        </Button>
      </div>
    </div>
  );
}
