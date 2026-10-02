import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentSession, RuntimeOptions } from "@majhi/acp";
import { DECISIONS_TASK, type DecideRequest, stateText } from "@majhi/shared";
import { accountRuntime, secretName } from "../accounts/homes.ts";
import type { AgentStore } from "../agents/store.ts";
import type { ConfigService } from "../config/service.ts";
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
  /** Records the stand-in's tokens and cost, under the `decisions` task. */
  usage?: UsageRecorder;
}

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
    const runtimeAccount = accountRuntime(deps.majhiHome, fm.account, account, apiKey);
    await deps.runtime.prepareHome(runtimeAccount);
    const cwd = join(deps.majhiHome, "decisions");
    await mkdir(cwd, { recursive: true });

    const { text: state, trimmed } = trimText(stateText(request.state), ACP_TOKENS);
    const prompt = buildPrompt({ ...request, state });
    const model = fm.model === "auto" ? undefined : fm.model;
    const effort = fm.effort === "auto" ? undefined : fm.effort;
    const session = await deps.runtime.startSession({
      account: runtimeAccount,
      options: deps.options,
      cwd,
      // The stand-in needs no files: a runner gives it an empty folder of its own.
      scratch: true,
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
    });
    const stopUsage = session.onEvent((event) => {
      if (event.type !== "turn") return;
      void deps.usage?.record(
        { task: DECISIONS_TASK, agent: fm.id, account: fm.account, tool: account.tool, auth: account.auth },
        event.usage,
      );
    });
    try {
      // The stand-in only answers. Every tool request is refused.
      session.setPermissionHandler(async () => undefined);
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
      await session.close().catch(() => undefined);
    }
  }
}

export async function ask(session: AgentSession, prompt: string): Promise<string> {
  let text = "";
  const stop = session.onEvent((event) => {
    if (event.type === "text") text += event.text;
  });
  const timer = setTimeout(() => void session.cancel(), TURN_TIMEOUT_MS);
  try {
    const { stopReason } = await session.prompt([{ type: "text", text: prompt }]);
    if (stopReason !== "end_turn") throw new Error(`The stand-in agent stopped early (${stopReason}).`);
    return text;
  } finally {
    clearTimeout(timer);
    stop();
  }
}
