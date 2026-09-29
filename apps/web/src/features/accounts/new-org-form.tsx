import { IdSchema } from "@majhi/shared";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { useCreateOrg } from "@/lib/studio-queries";
import { ORG_COLORS, orgIdFromName, suggestOrgColor } from "./model";

/** Inline "New org" form: a name, an id derived from it (editable) and a color. */
export function NewOrgForm({
  orgCount,
  onCreated,
  onCancel,
}: {
  orgCount: number;
  onCreated: (orgId: string) => void;
  onCancel: () => void;
}) {
  const create = useCreateOrg();
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [idEdited, setIdEdited] = useState(false);
  const [color, setColor] = useState<string>(() => suggestOrgColor(orgCount));
  const [problem, setProblem] = useState<string>();

  const shownId = idEdited ? id : orgIdFromName(name);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (name.trim() === "") return setProblem("Give the org a name");
    const parsed = IdSchema.safeParse(shownId);
    if (!parsed.success) return setProblem(parsed.error.issues[0]?.message ?? "Invalid id");
    setProblem(undefined);
    create.mutate(
      { id: parsed.data, name: name.trim(), color },
      { onSuccess: (org) => onCreated(org.id), onError: (e) => setProblem(describeError(e)) },
    );
  }

  return (
    <form
      onSubmit={submit}
      aria-label="New org"
      className="flex flex-col gap-3 rounded-md border border-line-strong bg-sunken p-3"
    >
      <Field label="Org name">
        {(p) => (
          <Input {...p} value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme" autoFocus />
        )}
      </Field>
      <Field label="Org id" hint="Used in file names and config. Lowercase letters, digits and dashes.">
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
                aria-label={`Color ${c}`}
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
      {problem && (
        <p role="alert" className="text-sm text-red">
          {problem}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" type="submit" disabled={create.isPending}>
          Create org
        </Button>
      </div>
    </form>
  );
}
