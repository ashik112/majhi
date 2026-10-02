import type { HealthCheck } from "@majhi/shared";
import { AUTO } from "@majhi/shared";
import { Anchor } from "lucide-react";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ChoiceChip } from "@/components/ui/choice-chip";
import { Select } from "@/components/ui/select";
import { HealthSteps } from "@/features/accounts/health-steps";
import { isUsableStatus } from "@/features/accounts/model";
import { buildOptions, newAgentFrontmatter, optionChips } from "@/features/agents/model";
import { cmd } from "@/lib/api";
import { describeError } from "@/lib/errors";
import { useAccountModels, useAccounts, useAgents, useCreateAgent, useSetBoss } from "@/lib/studio-queries";
import { Waiting } from "./bits";
import { BOSS_INSTRUCTIONS, bossId, firstHealthyAccount, hasBoss, isExistingRootAgent } from "./model";
import { Problem, StepFrame, useStep } from "./step-frame";

type Phase =
  | { kind: "form" }
  | { kind: "working" }
  | { kind: "result"; health: HealthCheck }
  | { kind: "error"; message: string };

/**
 * Captain: pick the model; majhi writes the rest (the id, the instructions, the permissions). It
 * creates a root agent, makes it captain, then runs its health check. Each part is skipped on retry
 * once it has worked.
 */
export function BossStep() {
  const step = useStep();
  const accounts = useAccounts().data ?? [];
  const agents = useAgents().data ?? [];
  const create = useCreateAgent();
  const setBoss = useSetBoss();

  const usable = accounts.filter((a) => isUsableStatus(a.status));
  const [accountPick, setAccountPick] = useState<string>();
  const account = usable.find((a) => a.id === accountPick) ?? firstHealthyAccount(accounts);
  const models = useAccountModels(account?.id);
  const [modelPick, setModelPick] = useState<string>();
  const [phase, setPhase] = useState<Phase>({ kind: "form" });
  const done = useRef({ created: false, boss: false });

  const current = agents.find((a) => a.status === "ok" && a.isBoss);
  const id = bossId(agents);
  const model = modelPick ?? models.data?.defaultModel ?? "";
  const effort = models.data?.defaultEffort ?? "";
  const modelChoices = buildOptions("model", models.data?.models, model, models.data?.defaultModel);
  const already = hasBoss(agents) && phase.kind === "form";

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
            ...(model !== "" ? { model } : {}),
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
  const ready = passed || already;

  return (
    <StepFrame
      primary={
        ready ? (
          <Button variant="primary" size="lg" onClick={step.next}>
            Continue
          </Button>
        ) : undefined
      }
    >
      {usable.length === 0 ? (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed border-line-control px-5 py-6">
          <p className="m-0 text-body text-fg-soft">The captain needs a signed-in AI account first.</p>
          <Button onClick={() => step.goTo("account")}>Go to AI account</Button>
        </div>
      ) : (
        <form
          aria-label="Captain agent"
          onSubmit={(e) => {
            e.preventDefault();
            void run();
          }}
          className="flex flex-col gap-6"
        >
          <div className="flex items-center gap-4 rounded-xl border border-line-strong bg-card px-4 py-3.5">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full border border-accent-line bg-accent-wash">
              <Anchor aria-hidden="true" className="size-[18px] text-accent-text" />
            </span>
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="font-mono text-body text-fg">
                @{already && current?.status === "ok" ? current.agent.frontmatter.id : id}
              </span>
              <span className="text-sm text-fg-muted text-pretty">
                majhi writes its instructions and gives it edit and shell. Change any of it later in Agents.
              </span>
            </div>
          </div>

          {usable.length > 1 && (
            <div className="flex items-center gap-3">
              <label htmlFor="captain-account" className="w-[64px] shrink-0 text-sm text-fg-muted">
                Runs on
              </label>
              <Select
                id="captain-account"
                value={account?.id ?? ""}
                disabled={locked}
                onChange={(e) => {
                  setAccountPick(e.target.value);
                  setModelPick(undefined);
                }}
                className="h-10 w-[280px] font-mono"
              >
                {usable.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.id}
                  </option>
                ))}
              </Select>
            </div>
          )}

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
          {models.isError && (
            <p className="m-0 text-sm text-fg-faint">
              Could not read the account's models. It will use its defaults.
            </p>
          )}
          {model === AUTO && (
            <p className="m-0 text-sm text-fg-faint">Auto lets majhi pick a model for each run.</p>
          )}

          {phase.kind === "form" && !already && (
            <div>
              <Button type="submit" variant="primary" size="lg" disabled={!account}>
                Make it the captain
              </Button>
            </div>
          )}
          {already && (
            <p className="m-0 text-base text-green">
              A captain is already set. Change it any time in Agents.
            </p>
          )}
          {phase.kind === "working" && <Waiting>Making the captain and checking it</Waiting>}
          {phase.kind === "error" && (
            <div className="flex flex-col gap-3">
              <Problem>{phase.message}</Problem>
              <div>
                <Button onClick={() => void run()}>Try again</Button>
              </div>
            </div>
          )}
          {phase.kind === "result" && (
            <div className="flex flex-col gap-3 rounded-xl border border-line-strong bg-card p-4">
              <HealthSteps health={phase.health} />
              {!passed && (
                <div>
                  <Button onClick={() => void run()}>Try again</Button>
                </div>
              )}
            </div>
          )}
        </form>
      )}
    </StepFrame>
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
      <legend className="mb-2 p-0 text-sm text-fg-muted">{label}</legend>
      <div className="flex flex-wrap gap-1.5">{children}</div>
      {note && <p className="m-0 text-sm text-amber text-pretty">{note}</p>}
    </fieldset>
  );
}
