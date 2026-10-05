import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentStore } from "./store.ts";

const file = (account: string) =>
  `---\nid: builder\nscope: acme\nrole: Builder\naccount: ${account}\nmodel: sonnet\nwhere: [anywhere]\n---\n\nBuild.\n`;

describe("AgentStore", () => {
  let home: string;
  let store: AgentStore;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "majhi-agents-"));
    await mkdir(join(home, "agents"));
    store = new AgentStore(home);
  });
  afterEach(() => rm(home, { recursive: true, force: true }));

  const account = async () => {
    const [stored] = await store.list();
    return stored?.ok ? stored.agent.frontmatter.account : undefined;
  };

  it("shows a hand edit at once, even one that keeps the file's size", async () => {
    await writeFile(store.path("builder"), file("claude-acme"));
    expect(await account()).toBe("claude-acme");
    await writeFile(store.path("builder"), file("claude-acmf"));
    expect(await account()).toBe("claude-acmf");
    await writeFile(store.path("builder"), file("claude-globex"));
    expect(await account()).toBe("claude-globex");
  });

  it("does not let a caller change what the next one gets", async () => {
    await writeFile(store.path("builder"), file("claude-acme"));
    const first = (await store.list())[0];
    if (first?.ok) first.agent.frontmatter.account = "changed";
    expect(await account()).toBe("claude-acme");
  });
});
