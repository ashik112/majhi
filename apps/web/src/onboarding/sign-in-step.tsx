import {
  type AgentEntry,
  freeId,
  planSetup,
  SETUP_CAPTAIN_ID,
  SETUP_ORG_KEY,
  type ToolId,
  type ToolInfo,
} from "@majhi/shared";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dot } from "@/components/ui/status-dot";
import { AccountProgress, AddAccountFlow, type ProgressStage } from "@/features/accounts/add-account-flow";
import { isUsableStatus, ORG_COLORS } from "@/features/accounts/model";
import { newAgentFrontmatter } from "@/features/agents/model";
import { cmd } from "@/lib/api";
import { describeError } from "@/lib/errors";
import {
  useAccounts,
  useAgents,
  useCreateAccount,
  useCreateOrg,
  useOrgs,
  useStartLogin,
  useTools,
} from "@/lib/studio-queries";
import { BOSS_INSTRUCTIONS } from "./model";
import { Problem } from "./step-frame";

const agentIds = (agents: readonly AgentEntry[]) =>
  agents.map((a) => (a.status === "ok" ? a.agent.frontmatter.id : a.id));

/**
 * Makes what a first sign-in needs, with defaults and without a question: one lead agent in the account's
 * workspace and the captain. An agent that exists is never replaced; the next free id is taken.
 */
export async function makeDefaults(account: string, org: string): Promise<void> {
  const agents = await cmd("agents.list", {});
  const taken = agentIds(agents);
  const hasLead = agents.some((a) => a.status === "ok" && a.agent.frontmatter.scope === org);
  const lead = freeId(`${org}-lead`, taken);
  if (!hasLead) {
    await cmd("agents.create", {
      id: lead,
      frontmatter: newAgentFrontmatter(org, "Lead", account),
      instructions: "",
    });
  }
  if (!agents.some((a) => a.status === "ok" && a.isBoss)) {
    const id = freeId(SETUP_CAPTAIN_ID, hasLead ? taken : [...taken, lead]);
    await cmd("agents.create", {
      id,
      frontmatter: { ...newAgentFrontmatter("root", "Root", account), origin: "setup" },
      instructions: BOSS_INSTRUCTIONS,
    });
    await cmd("boss.set", { id });
  }
}

/**
 * Step 1: one button each for Claude and Codex. majhi makes the workspace (Personal), the account, one lead
 * agent and the captain by itself; the owner only signs in.
 */
export function SignInStep({ onNext }: { onNext: () => void }) {
  const tools = useTools().data ?? [];
  const accounts = useAccounts().data ?? [];
  const orgs = useOrgs().data ?? [];
  const createOrg = useCreateOrg();
  const createAccount = useCreateAccount();
  const startLogin = useStartLogin();
  const agents = useAgents().data ?? [];
  const [stage, setStage] = useState<ProgressStage>();
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState<string>();
  const [finishing, setFinishing] = useState(false);
  const finished = useRef<string | undefined>(undefined);
  const orgOf = useRef<string | undefined>(undefined);

  const usable = accounts.filter((a) => isUsableStatus(a.status));
  const signedIn = usable[0];

  const doneId =
    stage?.kind === "login" && stage.state.phase === "signed-in"
      ? stage.accountId
      : stage?.kind === "result" && stage.health.ok
        ? stage.accountId
        : undefined;

  async function finish(account: string, org: string) {
    if (finished.current === account) return;
    finished.current = account;
    setFinishing(true);
    try {
      await makeDefaults(account, org);
      onNext();
    } catch (error) {
      finished.current = undefined;
      setProblem(describeError(error));
      setFinishing(false);
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: one finish per signed-in account
  useEffect(() => {
    if (doneId === undefined) return;
    const org = orgOf.current ?? accounts.find((a) => a.id === doneId)?.org;
    if (org !== undefined) void finish(doneId, org);
  }, [doneId]);

  /** The workspace and account for a first sign-in with `tool`, then the tool's own login. */
  async function begin(tool: ToolInfo) {
    setBusy(true);
    setProblem(undefined);
    try {
      // A sign-in that was started and never finished is picked up again, never a second account.
      const abandoned = accounts.find(
        (a) =>
          a.tool === tool.id &&
          a.auth === "login" &&
          a.agentCount === 0 &&
          (a.status === "unknown" || a.status === "needs-login") &&
          orgs.some((o) => o.id === a.org && o.id !== "private"),
      );
      let accountId: string;
      let org: string;
      if (abandoned !== undefined) {
        accountId = abandoned.id;
        org = abandoned.org;
      } else {
        const plan = planSetup(tool.id, {
          orgs: orgs.map((o) => o.id),
          accounts: accounts.map((a) => a.id),
          agents: agentIds(agents),
        });
        org = plan.org.id;
        if (!orgs.some((o) => o.id === org)) {
          await createOrg.mutateAsync({
            id: org,
            name: plan.org.name,
            color: ORG_COLORS[0],
            key: SETUP_ORG_KEY,
          });
        }
        accountId = (await createAccount.mutateAsync({ id: plan.account, tool: tool.id, org, auth: "login" }))
          .id;
      }
      orgOf.current = org;
      const started = await startLogin.mutateAsync(accountId);
      setStage({
        kind: "login",
        accountId,
        loginHint: tool.loginHint,
        terminalId: started.terminalId,
        state: { phase: "running" },
      });
    } catch (error) {
      setProblem(describeError(error));
    } finally {
      setBusy(false);
    }
  }

  const byId = (id: ToolId) => tools.find((t) => t.id === id);

  if (signedIn !== undefined && stage === undefined) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex min-h-12 items-center gap-3 rounded-lg border border-line-strong bg-card px-3.5">
          <Dot tone="green" size={7} />
          <span className="min-w-0 truncate font-mono text-base text-fg">{signedIn.id}</span>
          {signedIn.signedInAs && (
            <span className="min-w-0 truncate text-sm text-fg-faint">{signedIn.signedInAs}</span>
          )}
        </div>
        {problem && <Problem>{problem}</Problem>}
        <div>
          <Button
            variant="primary"
            size="lg"
            disabled={finishing}
            onClick={() => void finish(signedIn.id, signedIn.org)}
          >
            {finishing ? "Setting up" : "Continue"}
          </Button>
        </div>
      </div>
    );
  }

  if (key !== undefined) {
    return (
      <div className="rounded-xl border border-line-strong bg-card p-5">
        <AddAccountFlow
          defaultOrg={key}
          onHealthy={(id) => void finish(id, key)}
          renderDone={() => (finishing ? <p className="m-0 text-base text-fg-muted">Setting up</p> : null)}
        />
      </div>
    );
  }

  if (stage !== undefined) {
    return (
      <div className="flex flex-col gap-3">
        <div className="rounded-xl border border-line-strong bg-card p-5">
          <AccountProgress stage={stage} setStage={setStage} />
        </div>
        {finishing && (
          <p role="status" className="m-0 text-base text-fg-muted">
            Signed in. Setting up your workspace and the captain.
          </p>
        )}
        {problem && <Problem>{problem}</Problem>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        {(["claude", "codex"] as const).map((id, i) => {
          const tool = byId(id);
          return (
            <Button
              key={id}
              variant={i === 0 ? "primary" : "secondary"}
              size="lg"
              disabled={tool === undefined || busy}
              onClick={() => tool && void begin(tool)}
            >
              {busy ? "Starting" : `Sign in with ${tool?.name ?? (id === "claude" ? "Claude" : "Codex")}`}
            </Button>
          );
        })}
      </div>
      {problem && <Problem>{problem}</Problem>}
      <p className="m-0 text-sm text-fg-muted">
        Have an API key instead?{" "}
        <button
          type="button"
          disabled={busy}
          onClick={() => void chooseKey()}
          className="cursor-pointer text-fg-muted underline underline-offset-2 hover:text-fg"
        >
          Use a key
        </button>
      </p>
    </div>
  );

  async function chooseKey() {
    setBusy(true);
    setProblem(undefined);
    try {
      const plan = planSetup("claude", {
        orgs: orgs.map((o) => o.id),
        accounts: accounts.map((a) => a.id),
        agents: agentIds(agents),
      });
      if (!orgs.some((o) => o.id === plan.org.id)) {
        await createOrg.mutateAsync({
          id: plan.org.id,
          name: plan.org.name,
          color: ORG_COLORS[0],
          key: SETUP_ORG_KEY,
        });
      }
      setKey(plan.org.id);
    } catch (error) {
      setProblem(describeError(error));
    } finally {
      setBusy(false);
    }
  }
}
