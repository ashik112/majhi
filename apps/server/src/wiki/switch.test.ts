import type { WikiPatch } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import type { ConfigSections } from "../config/sections.ts";
import { mergeSettings } from "../config/settings.ts";
import { wikiEnabledFrom } from "./switch.ts";

function config(global: WikiPatch | undefined, orgs: Record<string, WikiPatch | undefined>) {
  const sections: ConfigSections = {
    exists: true,
    orgs: Object.fromEntries(
      Object.entries(orgs).map(([id, wiki]) => [id, { name: id, ...(wiki === undefined ? {} : { wiki }) }]),
    ),
    accounts: {},
    projects: {},
    boss: undefined,
  };
  return {
    settings: async () => mergeSettings(global === undefined ? {} : { wiki: global }),
    sections: async () => sections,
  };
}

describe("the wiki switch", () => {
  it("is on when nothing says otherwise", async () => {
    const enabled = wikiEnabledFrom(config(undefined, { acme: undefined }));
    expect(await enabled("acme")).toBe(true);
    expect(await enabled("unknown")).toBe(true);
  });

  it("follows the global setting when a workspace has none", async () => {
    const enabled = wikiEnabledFrom(config({ enabled: true }, { acme: undefined }));
    expect(await enabled("acme")).toBe(true);
  });

  it("lets the workspace's own value win over the global one, either way", async () => {
    const on = wikiEnabledFrom(config({ enabled: false }, { acme: { enabled: true }, globex: undefined }));
    expect([await on("acme"), await on("globex")]).toEqual([true, false]);
    const off = wikiEnabledFrom(config({ enabled: true }, { acme: { enabled: false }, globex: undefined }));
    expect([await off("acme"), await off("globex")]).toEqual([false, true]);
  });
});
