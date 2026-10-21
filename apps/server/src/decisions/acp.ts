import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type AgentSession, INTERNAL_ORG, type RuntimeOptions } from "@majhi/acp";
import { DECISIONS_TASK, type DecideRequest, stateText } from "@majhi/shared";
import { secretName, sessionRuntime } from "../accounts/homes.ts";
import type { AgentStore } from "../agents/store.ts";
import type { ConfigService } from "../config/service.ts";
import type { RoomAccess } from "../rooms/access.ts";
import { handlerOf, refuseAll } from "../rooms/session-decision.ts";
import type { AcpRuntime } from "../runtime.ts";
import type { SecretStore } from "../secrets/store.ts";
import type { UsageRecorder } from "../usage/recorder.ts";
import { buildPrompt, parseReply } from "./acpParse.ts";
import type { DecisionProvider, ProviderOutcome } from "./providers.ts";
import { trimText } from "./trim.ts";

const TURN_TIMEOUT_MS = 90_000;
/** A stand-in has a real window; still, keep its cost down. */
const ACP_TOKENS = 4_000;

export interface AcpProviderDeps {
  config: ConfigService;
  agents: AgentStore;
  secrets: SecretStore;
  runtime: AcpRuntime;
  options: RuntimeOptions;
  majhiHome: string;
  /** The agent named in `decisions.acp_agent`, if any. */
  standIn: () => Promise<string | undefined>;
  /** Before a session starts on a login account: its sign-in must belong to the person the account was pinned to. */
  guardSignIn?: ((account: string) => Promise<void>) | undefined;
  /** Records the stand-in's tokens and cost, under the `decisions` task. */
  usage?: UsageRecorder;
  /** Gives a Codex stand-in in a runner the hook token it needs, so its refused tools come back with the reason. */
  rooms?: RoomAccess | undefined;
  /** Sessions run in runner containers, where Codex's hook must be answered. */
  containerRunner?: boolean | undefined;
}

/** What the agent reads when the stand-in tries a tool: it only answers. */
const REFUSAL = "This session only answers. It has no tools.";

/** An agent (the captain by default) answering in place of Laya: one throwaway session, JSON only. */
export class AcpProvider implements DecisionProvider {
  readonly id = "acp" as const;

  constructor(private readonly deps: AcpProviderDeps) {}

  private async agentId(): Promise<string | undefined> {
    return (await this.deps.standIn()) ?? (await this.deps.config.sections()).boss;
  }

  async unavailable(): Promise<string | undefined> {
    const id = await this.agentId();
    if (id === undefined) return "No stand-in agent: set one or choose a captain";
    const stored = await this.deps.agents.get(id);
    if (stored === undefined || !stored.ok) return `The stand-in agent @${id} is missing or invalid`;
    return undefined;
  }

  async decide(request: DecideRequest): Promise<ProviderOutcome> {
    const { deps } = this;
    const id = await this.agentId();
    const stored = id === undefined ? undefined : await deps.agents.get(id);
    if (stored === undefined || !stored.ok) throw new Error("The stand-in agent is missing or invalid.");
    const fm = stored.agent.frontmatter;
    const { accounts } = await deps.config.sections();
    const account = accounts[fm.account];
    if (account === undefined) throw new Error(`Account "${fm.account}" is not in majhi.yaml.`);
    let apiKey: string | undefined;
    if (account.auth === "api-key" && account.key !== undefined) {
      apiKey = await deps.secrets.get(secretName(account.key));
      if (apiKey === undefined) throw new Error(`The API key of ${fm.account} is missing.`);
    }
    await deps.guardSignIn?.(fm.account);
    // The stand-in answers for no workspace: it has the internal home, never a workspace's.
    const runtimeAccount = sessionRuntime(
      deps.majhiHome,
      fm.account,
      account,
      INTERNAL_ORG,
      deps.containerRunner === true,
      apiKey,
    );
    await deps.runtime.prepareHome(runtimeAccount);
    const cwd = join(deps.majhiHome, "decisions");
    await mkdir(cwd, { recursive: true });

    const { text: state, trimmed } = trimText(stateText(request.state), ACP_TOKENS);
    const prompt = buildPrompt({ ...request, state });
    const model = fm.model === "auto" ? undefined : fm.model;
    const effort = fm.effort === "auto" ? undefined : fm.effort;
    // A Codex stand-in in a runner has its hook asked on every tool call: the session's own rule answers, with a reason.
    const rule = refuseAll(REFUSAL);
    const bound =
      account.tool === "codex" && deps.containerRunner === true
        ? deps.rooms?.attachSession({ decide: rule, hook: true })
        : undefined;
    let session: AgentSession;
    try {
      session = await deps.runtime.startSession({
        account: runtimeAccount,
        options: deps.options,
        cwd,
        // The stand-in needs no files: a runner gives it an empty folder of its own.
        scratch: true,
        ...(model === undefined ? {} : { model }),
        ...(effort === undefined ? {} : { effort }),
        ...(bound === undefined ? {} : { env: bound.env }),
      });
    } catch (err) {
      bound?.revoke();
      throw err;
    }
    const stopUsage = session.onEvent((event) => {
      if (event.type !== "turn") return;
      void deps.usage?.record(
        { task: DECISIONS_TASK, agent: fm.id, account: fm.account, tool: account.tool, auth: account.auth },
        event.usage,
      );
    });
    try {
      // The stand-in only answers. Every tool request is refused.
      session.setPermissionHandler(account.tool === "codex" ? handlerOf(rule) : async () => undefined);
      let reply = await ask(session, prompt);
      let parsed = parseReply(reply, request);
      if (!parsed.ok) {
        reply = await ask(
          session,
          `That reply was not usable (${parsed.problem}) Reply again with only the JSON object.`,
        );
        parsed = parseReply(reply, request);
      }
      if (!parsed.ok) throw new Error(`@${fm.id} did not give a valid answer: ${parsed.problem}`);
      return { answers: parsed.answers, estimated: true, trimmed };
    } finally {
      stopUsage();
      bound?.revoke();
      await session.close().catch(() => undefined);
    }
  }
}

export async function ask(
  session: AgentSession,
  prompt: string,
  timeoutMs: number = TURN_TIMEOUT_MS,
): Promise<string> {
  let text = "";
  const stop = session.onEvent((event) => {
    if (event.type === "text") text += event.text;
  });
  const timer = setTimeout(() => void session.cancel(), timeoutMs);
  try {
    const { stopReason } = await session.prompt([{ type: "text", text: prompt }]);
    if (stopReason !== "end_turn") throw new Error(`The stand-in agent stopped early (${stopReason}).`);
    return text;
  } finally {
    clearTimeout(timer);
    stop();
  }
}
