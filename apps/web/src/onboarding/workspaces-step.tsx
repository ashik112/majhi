import { IdSchema, PRIVATE } from "@majhi/shared";
import * as m from "motion/react-m";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ORG_COLORS, orgColorName, orgIdFromName, suggestOrgColor } from "@/features/accounts/model";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { plural } from "@/lib/format";
import { useCreateOrg } from "@/lib/studio-queries";
import { GroupTitle, StepFrame, useStep } from "./step-frame";

/**
 * Workspaces: Private is always there. Add a workspace per client or team by name and color; the
 * id follows from the name. Private completes the step for owners who only work for themselves.
 */
export function WorkspacesStep() {
  const step = useStep();
  const workspaces = step.status.workspaces;
  const others = workspaces.filter((w) => w.id !== PRIVATE).length;

  return (
    <StepFrame
      note={others === 0 ? "Only working for yourself? Private is enough." : undefined}
      primary={
        others === 0 ? (
          <Button variant="primary" size="lg" onClick={step.next}>
            Continue with Private
          </Button>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-7">
        <ul aria-label="Workspaces" className="m-0 flex list-none flex-col gap-1.5 p-0">
          {(workspaces.length > 0
            ? workspaces
            : [{ id: PRIVATE, name: "Private", projects: 0, git: [] }]
          ).map((w) => (
            <m.li
              key={w.id}
              layout="position"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
              className="flex min-h-12 items-center gap-3 rounded-lg border border-line-strong bg-card px-3.5"
            >
              <span
                aria-hidden="true"
                className="size-3 shrink-0 rounded-full"
                style={{ backgroundColor: "color" in w && w.color ? w.color : "var(--c-fg-dim)" }}
              />
              <span className="min-w-0 truncate text-body font-medium text-fg">{w.name}</span>
              <span className="font-mono text-sm text-fg-faint">{w.id}</span>
              <span className="ml-auto shrink-0 text-sm text-fg-faint">
                {w.id === PRIVATE ? "Built in, for your own work" : plural(w.projects, "project")}
              </span>
            </m.li>
          ))}
        </ul>
        <section aria-labelledby="add-workspace" className="flex flex-col gap-3">
          <GroupTitle>
            <span id="add-workspace">Add a client or team</span>
          </GroupTitle>
          <AddWorkspace count={workspaces.length} primary={!step.done} />
        </section>
      </div>
    </StepFrame>
  );
}

function AddWorkspace({ count, primary }: { count: number; primary: boolean }) {
  const create = useCreateOrg();
  const [name, setName] = useState("");
  const [colorPick, setColor] = useState<string>();
  const [problem, setProblem] = useState<string>();
  const color = colorPick ?? suggestOrgColor(count);
  const id = orgIdFromName(name);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() === "") return setProblem("Give the workspace a name");
    const parsed = IdSchema.safeParse(id);
    if (!parsed.success)
      return setProblem(parsed.error.issues[0]?.message ?? "Use letters and digits in the name");
    setProblem(undefined);
    create.mutate(
      { id: parsed.data, name: name.trim(), color },
      {
        onSuccess: () => {
          setName("");
          setColor(undefined);
        },
        onError: (e) => setProblem(describeError(e)),
      },
    );
  };

  return (
    <form aria-label="New workspace" onSubmit={submit} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Input
          aria-label="Workspace name"
          placeholder="Acme"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-invalid={problem ? true : undefined}
          className="h-10 w-[240px] flex-none text-body"
        />
        <fieldset className="m-0 flex items-center gap-1.5 border-0 p-0">
          <legend className="sr-only">Color</legend>
          {ORG_COLORS.map((c) => (
            <label key={c} className="relative flex size-7 cursor-pointer items-center justify-center">
              <input
                type="radio"
                name="workspace-color"
                value={c}
                checked={color === c}
                onChange={() => setColor(c)}
                aria-label={orgColorName(c)}
                className="peer absolute inset-0 size-full cursor-pointer opacity-0"
              />
              <span
                aria-hidden="true"
                style={{ backgroundColor: c }}
                className={cn(
                  "block size-5 rounded-full ring-offset-2 ring-offset-transparent transition-[box-shadow] duration-150",
                  "peer-checked:shadow-[0_0_0_2px_var(--c-base),0_0_0_3.5px_var(--c-fg-soft)]",
                  "peer-focus-visible:shadow-[0_0_0_2px_var(--c-base),0_0_0_3.5px_var(--c-accent)]",
                )}
              />
            </label>
          ))}
        </fieldset>
        <Button
          type="submit"
          variant={primary ? "primary" : "secondary"}
          size="lg"
          disabled={create.isPending}
        >
          {create.isPending ? "Adding" : "Add workspace"}
        </Button>
      </div>
      {problem ? (
        <p role="alert" className="m-0 text-sm text-red">
          {problem}
        </p>
      ) : (
        <p className="m-0 text-sm text-fg-faint">
          {id ? (
            <>
              Saved as <span className="font-mono text-fg-muted">{id}</span>. Rename it any time.
            </>
          ) : (
            "One per client or team. Each gets its own accounts, repos and git logins."
          )}
        </p>
      )}
    </form>
  );
}
