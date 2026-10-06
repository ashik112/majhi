import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeOptions, TurnUsage } from "@majhi/acp";
import { CommitShaSchema, ContentHashSchema, type WikiPage, WikiPageSchema } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { mergeSettings } from "../config/settings.ts";
import { openMemoryDb } from "../memory/db.ts";
import { HashEmbedder } from "../memory/embedder.ts";
import { Housekeeper } from "../memory/housekeeper.ts";
import { Store } from "../store/index.ts";
import { fakeRuntime } from "../testing/fakeRuntime.ts";
import type { UsageRecorder } from "../usage/recorder.ts";
import { NOT_IN_WIKI, WikiAsk } from "./ask.ts";
import { WikiIndex } from "./search.ts";

const SHA = CommitShaSchema.parse("a".repeat(40));
const HASH = ContentHashSchema.parse("c".repeat(64));

function page(org: string, project: string | undefined, text: string, path: string): WikiPage {
  return WikiPageSchema.parse({
    id: "overview",
    org,
    ...(project === undefined ? {} : { project }),
    kind: "overview",
    title: "Overview",
    body: `${text} [1]`,
    claims: [
      {
        n: 1,
        text,
        proven: true,
        sources: [{ repo: project ?? "system", commit: SHA, path, lines: [3, 5], hash: HASH }],
      },
    ],
    roles: [],
    builtFrom: { [project ?? "system"]: SHA },
    v: 1,
  });
}

const USAGE: TurnUsage = {
  inputTokens: 500,
  outputTokens: 50,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reported: true,
};

/** Acme has two projects and a workspace page. Globex has one project whose text matches the same words. */
async function world(options: { cited?: number[]; answer?: string; rest?: string } = {}) {
  const store = new Store(":memory:");
  const db = openMemoryDb(":memory:");
  const embedder = new HashEmbedder();
  const index = new WikiIndex(db, (texts) => embedder.embed(texts));
  const pages = [
    page("acme", "api", "The billing service charges cards through Stripe.", "api/charge.py"),
    page(
      "acme",
      "web",
      "The billing screen shows the card form and calls the billing service.",
      "web/card.ts",
    ),
    page("acme", undefined, "Billing runs across the api and the web repo.", "system/billing.md"),
    page("globex", "shop", "The billing service charges cards through a secret vault.", "shop/vault.py"),
  ];
  for (const p of pages) {
    store.wiki.save(p);
    await index.put(p);
  }
  for (const [org, project] of [
    ["acme", "api"],
    ["acme", "web"],
    ["globex", "shop"],
  ] as const) {
    store.wiki.saveState(org, project, {
      builtCommit: SHA,
      sources: {},
      rules: 1,
      gaps: { couldNot: [], failed: [] },
    });
  }
  const home = mkdtempSync(join(tmpdir(), "wiki-ask-"));
  const runtime = fakeRuntime();
  const prompts: string[] = [];
  const reply = {
    cited: options.cited ?? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 99],
    answer: options.answer ?? "It charges cards.",
  };
  runtime.onSession = (session) => {
    session.script = async (turn) => {
      prompts.push(turn.text);
      turn.emit({ type: "text", messageId: "m", text: JSON.stringify(reply) });
      turn.emit({ type: "turn", usage: USAGE });
      return "end_turn";
    };
  };
  const housekeeper = new Housekeeper({
    config: {
      settings: async () => mergeSettings({}),
      sections: async () => ({
        boss: "acme-writer",
        accounts: { main: { tool: "claude", auth: "login", org: "private" } },
      }),
      file: join(home, "majhi.yaml"),
    } as never,
    agents: {
      get: async () => ({
        ok: true,
        agent: { frontmatter: { id: "acme-writer", account: "main", scope: "root", where: ["anywhere"] } },
      }),
    } as never,
    secrets: {} as never,
    runtime,
    options: {} as RuntimeOptions,
    majhiHome: home,
    usage: { record: async () => {} } as unknown as UsageRecorder,
  });
  const orgOf: Record<string, string[]> = { acme: ["api", "web"], globex: ["shop"] };
  const ask = new WikiAsk({
    repo: store.wiki,
    index,
    housekeeper,
    projects: async (org) => orgOf[org] ?? [],
    rest: async () => options.rest,
    unavailable: async () => undefined,
  });
  return { ask, sessions: () => runtime.starts.length, prompts };
}

describe("wiki.ask", () => {
  it("never returns a source or page from another workspace, or from a project outside the scope", async () => {
    const { ask, prompts } = await world();
    const whole = await ask.answer("acme", undefined, "How does the billing service charge cards?");
    expect(whole.found).toBe(true);
    expect(new Set(whole.sources.map((s) => s.repo))).toEqual(new Set(["api", "web", "system"]));
    expect(whole.sources.map((s) => s.path)).not.toContain("shop/vault.py");
    expect(prompts.join("\n")).not.toContain("secret vault");

    const one = await ask.answer("acme", "api", "How does the billing service charge cards?");
    expect(one.sources.map((s) => s.path)).toEqual(["api/charge.py"]);
    expect(prompts.at(-1)).not.toContain("billing screen");

    await expect(ask.answer("acme", "shop", "How does the billing service charge cards?")).rejects.toThrow(
      '"shop" is not a project of workspace "acme".',
    );
  });

  it("drops a cited passage number it was not given, and answers not found when none was", async () => {
    const some = await world({ cited: [1, 40] });
    const out = await some.ask.answer("acme", "api", "How does the billing service charge cards?");
    expect(out).toMatchObject({ found: true, answer: "It charges cards.", pages: ["overview"] });
    expect(out.sources).toHaveLength(1);

    const none = await world({ cited: [40, 0, -1], answer: "It uses Paypal." });
    expect(await none.ask.answer("acme", "api", "How does the billing service charge cards?")).toEqual({
      answer: NOT_IN_WIKI,
      sources: [],
      pages: [],
      found: false,
    });
  });

  it("does not call the model when nothing in the scope matches, and costs nothing when asked again", async () => {
    const { ask, sessions } = await world();
    const nothing = await ask.answer("acme", "api", "What colour is the moon?");
    expect(nothing).toEqual({ answer: NOT_IN_WIKI, sources: [], pages: [], found: false });
    expect(sessions()).toBe(0);
    // Words only another workspace's page holds find nothing here.
    expect(await ask.answer("acme", undefined, "secret vault")).toMatchObject({ found: false });
    expect(sessions()).toBe(0);

    await ask.answer("acme", "api", "How does the billing service charge cards?");
    await ask.answer("acme", "api", "  how does the BILLING service charge cards? ");
    expect(sessions()).toBe(1);
  });

  it("refuses when the workspace budget is used up, and answers again once it has room", async () => {
    const { ask, sessions } = await world({ rest: "Workspace acme has used its budget." });
    await expect(ask.answer("acme", "api", "How does the billing service charge cards?")).rejects.toThrow(
      "Workspace acme has used its budget.",
    );
    expect(sessions()).toBe(0);
  });
});
