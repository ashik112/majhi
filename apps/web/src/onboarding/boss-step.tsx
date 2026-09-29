import type { HealthCheck } from "@majhi/shared";
import { AUTO } from "@majhi/shared";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { HealthSteps } from "@/features/accounts/health-steps";
import { isUsableStatus, statusInfo } from "@/features/accounts/model";
import { buildOptions, newAgentFrontmatter } from "@/features/agents/model";
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
 * Step 3: create the boss, a root agent that sets up and runs majhi. Creates the agent, makes it
 * boss, then runs its health check. Each step is skipped on retry once it has worked.
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
        <h1 className="text-lg font-semibold text-balance">Choose the boss</h1>
        <p className="text-base text-fg-muted text-pretty">
          The boss is an agent that sets up and runs majhi for you. Pick the account it uses. You can change
          all of this later in Studio.
        </p>
      </div>

      {usable.length === 0 ? (
        <p className="text-base text-fg-muted">
          No account is signed in and healthy yet. Add one in the previous step first.
        </p>
      ) : (
        <form
          aria-label="Boss agent"
          onSubmit={(e) => {
            e.preventDefault();
            void run();
          }}
          className="flex flex-col gap-4 rounded-xl border border-line-strong bg-panel p-5"
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
          <Field label="Account">
            {(p) => (
              <Select
                {...p}
                value={account?.id ?? ""}
                disabled={locked}
                onChange={(e) => {
                  setAccountPick(e.target.value);
                  setModelPick(undefined);
                  setEffortPick(undefined);
                }}
              >
                {usable.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.id} ({statusInfo(a.status).label.toLowerCase()})
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Model" warning={modelChoices.warning}>
              {(p) => (
                <Select {...p} value={model} disabled={locked} onChange={(e) => setModelPick(e.target.value)}>
                  {modelChoices.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Effort" warning={effortChoices.warning}>
              {(p) => (
                <Select
                  {...p}
                  value={effort}
                  disabled={locked}
                  onChange={(e) => setEffortPick(e.target.value)}
                >
                  {effortChoices.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
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
                Create boss
              </Button>
            </div>
          )}
          {phase.kind === "working" && (
            <p role="status" className="text-base text-fg-muted">
              Creating the boss and checking it
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
