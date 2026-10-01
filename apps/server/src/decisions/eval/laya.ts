/**
 * Laya and the rules for the labeled evals, without a server: Laya runs straight from the venv the
 * host helper installed (~/.majhi/laya), through `laya-bridge.py`. Answers pass majhi's gate with
 * the default settings, as the decision service would gate them. Nothing here touches majhi's
 * database or a running server.
 */
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Answer,
  type DecideRequestInput,
  DecideRequestSchema,
  type DecisionResult,
  DecisionSettingsSchema,
  gateAnswer,
  type LayaAnswer,
} from "@majhi/shared";
import { fromLayaCall, toLayaCall } from "../layaMap.ts";
import { rulesProvider } from "../rules.ts";

const here = dirname(fileURLToPath(import.meta.url));
const settings = DecisionSettingsSchema.parse({});

/** Laya, through a small Python bridge: one request per line in, one answer per line out. */
export class Laya {
  private readonly proc: ChildProcessWithoutNullStreams;
  private buffer = "";
  private waiting: ((line: string) => void)[] = [];

  constructor() {
    const dir = join(homedir(), ".majhi", "laya");
    this.proc = spawn(join(dir, "venv", "bin", "python"), [join(here, "laya-bridge.py")], {
      env: { ...process.env, HF_HOME: join(dir, "hf"), HF_HUB_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1" },
    });
    this.proc.stdout.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      let at = this.buffer.indexOf("\n");
      while (at !== -1) {
        const line = this.buffer.slice(0, at);
        this.buffer = this.buffer.slice(at + 1);
        this.waiting.shift()?.(line);
        at = this.buffer.indexOf("\n");
      }
    });
  }

  static available(): boolean {
    const python = join(homedir(), ".majhi", "laya", "venv", "bin", "python");
    return spawnSync(python, ["-c", "import laya_mlx"], { timeout: 60_000 }).status === 0;
  }

  predict(state: string, questions: unknown): Promise<Record<string, LayaAnswer>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Laya did not answer in 60 s")), 60_000);
      this.waiting.push((line) => {
        clearTimeout(timer);
        resolve((JSON.parse(line) as { answers: Record<string, LayaAnswer> }).answers);
      });
      this.proc.stdin.write(`${JSON.stringify({ state, questions })}\n`);
    });
  }

  close(): void {
    this.proc.kill();
  }
}

let n = 0;
/** The decision service's `decide`, for one provider, with the same gate. */
export function decider(provider: "laya" | "rules", laya?: Laya) {
  return async (input: DecideRequestInput): Promise<DecisionResult> => {
    const request = DecideRequestSchema.parse(input);
    let answers: Record<string, Answer>;
    if (provider === "laya" && laya !== undefined) {
      const call = toLayaCall(request);
      answers = fromLayaCall(call, request, await laya.predict(call.text, call.questions));
    } else {
      answers = (await rulesProvider.decide(request)).answers;
    }
    const gated = Object.fromEntries(
      Object.entries(answers).map(([key, a]) => {
        const q = request.questions[key];
        if (q === undefined) return [key, a];
        const g = gateAnswer(q, a, settings);
        return [key, { ...a, gate: provider === "rules" ? { ...g, accepted: false } : g }];
      }),
    );
    n += 1;
    return {
      id: `eval_${n}`,
      answers: gated,
      provider,
      skipped: [],
      trimmed: false,
      estimated: false,
      durationMs: 0,
    };
  };
}
