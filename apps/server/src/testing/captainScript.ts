import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  RESULTS_FILE,
  ResultSchema,
  SCRIPT_FILE,
  type ScriptResult,
  type ScriptStep,
} from "@majhi/acp/testing";
import type { BossWorld } from "./boss.ts";

export interface CaptainRule {
  /** Matched against the whole incoming prompt. Strings match as a substring. */
  when: RegExp | string;
  /** Tool calls (on majhi-admin unless `server` is set, tool names as agents see them, like `majhi_tasks_start`) and text. */
  steps: ScriptStep[];
}

export interface CaptainScript {
  /** Every call the fake captain made so far, with the text each tool answered. */
  results(): Promise<ScriptResult[]>;
  /** Waits until `count` calls were made, or fails. */
  calls(count: number): Promise<ScriptResult[]>;
}

const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Installs a script for the captain's turns: the first rule matching a prompt makes its MCP calls
 * for real through the session's servers, then says its text. A prompt no rule matches echoes as
 * before. `onResult` sees each call's answer once, as the test reads results. By default the script
 * is for the world's captain chat; pass `task` for a lane's chat.
 *
 * @example
 * const script = await captainScript(w, [
 *   { when: /Wake/, steps: [{ tool: "majhi_tasks_start", args: { id, reason: "next" } }, { say: "Started." }] },
 * ]);
 * await w.h.majhi.services.lanes.tell("acme", "Wake: the queue is open", "wake");
 * const [started] = await script.calls(1);
 */
export async function captainScript(
  world: BossWorld,
  rules: CaptainRule[],
  options: { task?: string; onResult?: (result: ScriptResult) => void } = {},
): Promise<CaptainScript> {
  const dir = world.taskDir(options.task ?? world.chat.id);
  await mkdir(dir, { recursive: true });
  const body = {
    rules: rules.map((r) => ({
      when: typeof r.when === "string" ? literal(r.when) : r.when.source,
      flags: typeof r.when === "string" ? "" : r.when.flags,
      steps: r.steps,
    })),
  };
  await writeFile(join(dir, SCRIPT_FILE), JSON.stringify(body));
  await appendFile(join(dir, RESULTS_FILE), "");
  let seen = 0;
  const results = async (): Promise<ScriptResult[]> => {
    const all = (await readFile(join(dir, RESULTS_FILE), "utf8"))
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => ResultSchema.parse(JSON.parse(l) as unknown));
    for (const r of all.slice(seen)) options.onResult?.(r);
    seen = all.length;
    return all;
  };
  return {
    results,
    async calls(count) {
      let all: ScriptResult[] = [];
      await world.until(async () => {
        all = await results();
        return all.length >= count;
      }, `${count} scripted captain calls`);
      return all;
    },
  };
}
