import type { HealthCheck } from "@majhi/shared";
import { AUTO } from "@majhi/shared";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ChoiceChip } from "@/components/ui/choice-chip";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { HealthSteps } from "@/features/accounts/health-steps";
import { isUsableStatus, statusInfo } from "@/features/accounts/model";
import { buildOptions, newAgentFrontmatter, optionChips } from "@/features/agents/model";
import { cmd } from "@/lib/api";
import { describeError } from "@/lib/errors";
import { useAccountModels, useAccounts, useAgents, useCreateAgent, useSetBoss } from "@/lib/studio-queries";
import { BOSS_INSTRUCTIONS, bossId, firstHealthyAccount, isExistingRootAgent } from "./model";
import type { OnboardingStepProps } from "./steps";

type Phase =
  | { kind: "form" }
  | { kind: "working" }
  | { kind: "result"; health: HealthCheck }
  | { kind: "error"; message: string };

/**
 * Step 3: create the captain, a root agent that sets up and runs majhi. Creates the agent, makes it
 * captain, then runs its health check. Each step is skipped on retry once it has worked.
 */
export function BossStep({ isLast, onComplete, onSkip }: OnboardingStepProps) {
  const accounts = useAccounts().data ?? [];
  const agents = useAgents().data ?? [];
  const create = useCreateAgent();
  const setBoss = useSetBoss();

  const usable = accounts.filter((a) => isUsableStatus(a.status));
  const [accountPick, setAccountPick] = useState<string>();
  const account = usable.find((a) => a.id === accountPick) ?? firstHealthyAccount(accounts);
  const models = useAccountModels(account?.id);
  const [modelPick, setModelPick] = useState<string>();
  const [effortPick, setEffortPick] = useState<string>();
  const [idPick, setIdPick] = useState<string>();
  const [phase, setPhase] = useState<Phase>({ kind: "form" });
  const done = useRef({ created: false, boss: false });

  const id = idPick ?? bossId(agents);
  const model = modelPick ?? models.data?.defaultModel ?? "";
  const effort = effortPick ?? models.data?.defaultEffort ?? "";
  const modelChoices = buildOptions("model", models.data?.models, model, models.data?.defaultModel);
  const effortChoices = buildOptions("effort", models.data?.efforts, effort, models.data?.defaultEffort);

  async function run() {
    if (!account) return;
    setPhase({ kind: "working" });
    try {
      if (!done.current.created && !isExistingRootAgent(agents, id)) {
        const frontmatter = newAgentFrontmatter("root", "Root", account.id);
        await create.mutateAsync({
          id,
          frontmatter: {
            ...frontmatter,
            perms: ["edit", "shell"],
            origin: "setup",
            ...(model && model !== "" ? { model } : {}),
            ...(effort ? { effort } : {}),
          },
          instructions: BOSS_INSTRUCTIONS,
        });
      }
      done.current.created = true;
      if (!done.current.boss) {
        await setBoss.mutateAsync(id);
        done.current.boss = true;
      }
      const health = await cmd("agents.health", { id });
      setPhase({ kind: "result", health });
    } catch (error) {
      setPhase({ kind: "error", message: describeError(error) });
    }
  }

  const locked = phase.kind !== "form";
  const passed = phase.kind === "result" && phase.health.ok;

  return (
    <>
      <div className="flex flex-col gap-2">
        <h1 className="text-lg font-semibold text-balance">Choose the captain</h1>
        <p className="text-base text-fg-muted text-pretty">
          The captain is an agent that sets up and runs majhi for you. Pick the account it uses. You can
          change all of this later in Agents.
        </p>
      </div>

      {usable.length === 0 ? (
        <p className="text-base text-fg-muted">
          No account is signed in and healthy yet. Add one in the previous step first.
        </p>
      ) : (
        <form
          aria-label="Captain agent"
          onSubmit={(e) => {
            e.preventDefault();
            void run();
          }}
          className="flex flex-col gap-4 rounded-xl border border-line-strong bg-card p-5"
        >
          <Field label="Agent id">
            {(p) => (
              <Input
                {...p}
                className="font-mono"
                value={id}
                disabled={locked}
                onChange={(e) => setIdPick(e.target.value)}
              />
            )}
          </Field>
          <Chips label="Account">
            {usable.map((a) => (
              <ChoiceChip
                key={a.id}
                pressed={account?.id === a.id}
                disabled={locked}
                aria-label={`${a.id}, ${statusInfo(a.status).label.toLowerCase()}`}
                className="min-h-11 flex-col items-start gap-px px-2.5 py-1"
                onClick={() => {
                  setAccountPick(a.id);
                  setModelPick(undefined);
                  setEffortPick(undefined);
                }}
              >
                <span className="font-mono text-sm">{a.id}</span>
                <span className="text-[0.625rem] leading-4 font-normal text-fg-faint">
                  {statusInfo(a.status).label}
                </span>
              </ChoiceChip>
            ))}
          </Chips>
          <Chips label="Model" note={modelChoices.warning}>
            {optionChips(modelChoices, models.data?.models).map((o) => (
              <ChoiceChip
                key={o.value}
                mono={o.value !== "" && o.value !== AUTO}
                pressed={model === o.value}
                disabled={locked}
                title={o.title}
                onClick={() => setModelPick(o.value)}
              >
                {o.label}
              </ChoiceChip>
            ))}
          </Chips>
          <Chips label="Effort" note={effortChoices.warning}>
            {optionChips(effortChoices, models.data?.efforts).map((o) => (
              <ChoiceChip
                key={o.value}
                mono={o.value !== "" && o.value !== AUTO}
                pressed={effort === o.value}
                disabled={locked}
                title={o.title}
                onClick={() => setEffortPick(o.value)}
              >
                {o.label}
              </ChoiceChip>
            ))}
          </Chips>
          {models.isError && (
            <p className="text-sm text-fg-faint">
              Could not read the account's models. It will use its defaults.
            </p>
          )}
          {model === AUTO && (
            <p className="text-sm text-fg-faint">Auto lets majhi pick a model for each run.</p>
          )}

          {phase.kind === "form" && (
            <div>
              <Button type="submit" variant="primary" disabled={!account}>
                Create captain
              </Button>
            </div>
          )}
          {phase.kind === "working" && (
            <p role="status" className="text-base text-fg-muted">
              Creating the captain and checking it
            </p>
          )}
          {phase.kind === "error" && (
            <div role="alert" className="flex flex-col gap-3">
              <p className="text-base text-red text-pretty">{phase.message}</p>
              <div>
                <Button onClick={() => void run()}>Retry</Button>
              </div>
            </div>
          )}
          {phase.kind === "result" && (
            <div className="flex flex-col gap-3">
              <HealthSteps health={phase.health} />
              {passed ? (
                <div>
                  <Button variant="primary" onClick={onComplete}>
                    {isLast ? "Open majhi" : "Continue"}
                  </Button>
                </div>
              ) : (
                <div>
                  <Button onClick={() => void run()}>Retry</Button>
                </div>
              )}
            </div>
          )}
        </form>
      )}
      {onSkip && !passed && (
        <div>
          <Button variant="ghost" onClick={onSkip}>
            Skip for now
          </Button>
        </div>
      )}
    </>
  );
}

/** A label over a row of chips, with an optional warning under it. */
function Chips({
  label,
  note,
  children,
}: {
  label: string;
  note?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
      <legend className="mb-2 p-0 text-sm text-fg-faint">{label}</legend>
      <div className="flex flex-wrap gap-1.5">{children}</div>
      {note && <p className="text-sm text-amber text-pretty">{note}</p>}
    </fieldset>
  );
}
