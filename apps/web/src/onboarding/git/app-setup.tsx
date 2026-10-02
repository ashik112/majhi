import type { GitAppSetup, GitAppsSetInput } from "@majhi/shared";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { HOST_LABEL } from "@/lib/hosts";
import { useSetGitApp } from "@/lib/onboarding-queries";
import { CopyValue, ExternalButton } from "../bits";
import { Problem } from "../step-frame";

const FIELD_LABEL = { clientId: "Client ID", key: "Key", secret: "Secret" } as const;

/**
 * The one-time setup of majhi's app on a git host, exactly as `gitAppSetup()` words it: the page
 * to open, numbered steps, values to copy, then the fields majhi needs. Saving starts the sign-in
 * again.
 */
export function AppSetup({ setup, onSaved }: { setup: GitAppSetup; onSaved: () => void }) {
  const save = useSetGitApp();
  const [values, setValues] = useState<Record<string, string>>({});
  const filled = setup.needs.every((n) => (values[n] ?? "").trim() !== "");
  const clientLabel = setup.kind === "gitlab" ? "Application ID" : FIELD_LABEL.clientId;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!filled) return;
    const v = (k: string) => (values[k] ?? "").trim();
    const input: GitAppsSetInput =
      setup.kind === "github"
        ? { kind: "github", clientId: v("clientId") }
        : setup.kind === "gitlab"
          ? { kind: "gitlab", host: setup.host, clientId: v("clientId") }
          : { kind: "bitbucket", consumer: { key: v("key"), secret: v("secret") } };
    save.mutate(input, { onSuccess: onSaved });
  };

  return (
    <section aria-label={setup.title} className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <h3 className="m-0 text-md font-semibold text-fg">{setup.title}</h3>
        <p className="m-0 text-base text-fg-muted text-pretty">
          {HOST_LABEL[setup.kind]} needs to know majhi once before any workspace can sign in. It takes about a
          minute.
        </p>
      </div>
      <ol className="m-0 flex list-none flex-col gap-3 p-0">
        {setup.steps.map((text, i) => (
          <li key={text} className="flex gap-3">
            <span
              aria-hidden="true"
              className="flex size-6 shrink-0 items-center justify-center rounded-full border border-line-control font-mono text-xs text-fg-muted tabular-nums"
            >
              {i + 1}
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-2.5 pt-0.5">
              <p className="m-0 text-base text-fg-soft text-pretty">{text}</p>
              {i === 0 && (
                <div>
                  <ExternalButton href={setup.link.url} size="md">
                    {setup.link.label}
                  </ExternalButton>
                </div>
              )}
              {i === valuesStep(setup) && (
                <div className="flex flex-col gap-1.5">
                  {setup.values.map((v) => (
                    <CopyValue key={v.label} label={v.label} value={v.value} />
                  ))}
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
      <form onSubmit={submit} aria-label={`${HOST_LABEL[setup.kind]} app`} className="flex flex-col gap-3">
        <div className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3">
          {setup.needs.map((need) => (
            <Field key={need} label={need === "clientId" ? clientLabel : FIELD_LABEL[need]}>
              {(p) => (
                <Input
                  {...p}
                  className="h-10 font-mono"
                  type={need === "secret" ? "password" : "text"}
                  autoComplete="off"
                  spellCheck={false}
                  value={values[need] ?? ""}
                  onChange={(e) => setValues({ ...values, [need]: e.target.value })}
                />
              )}
            </Field>
          ))}
        </div>
        {save.error && <Problem>{save.error.message}</Problem>}
        <div>
          <Button type="submit" variant="primary" size="lg" disabled={!filled || save.isPending}>
            {save.isPending ? "Saving" : "Save and sign in"}
          </Button>
        </div>
      </form>
    </section>
  );
}

/** The step that says "the values below", where the copy rows go. */
function valuesStep(setup: GitAppSetup): number {
  const i = setup.steps.findIndex((s) => /values below/i.test(s));
  return i === -1 ? 1 : i;
}
