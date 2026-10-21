import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RuntimeOptions } from "../index.ts";
import { claude } from "./claude.ts";

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "majhi-claude-identity-"));
});
afterEach(() => rm(home, { recursive: true, force: true }));

/** Anthropic as the test sees it: one profile per token, refused for any other. */
function profiles(byToken: Record<string, unknown>): { calls: string[]; options: RuntimeOptions } {
  const calls: string[] = [];
  const answer: typeof fetch = async (_url, init) => {
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    calls.push(auth);
    const profile = byToken[auth.slice("Bearer ".length)];
    return profile === undefined
      ? new Response("{}", { status: 401 })
      : new Response(JSON.stringify(profile), { status: 200 });
  };
  return {
    calls,
    options: {
      base: { PATH: "/usr/bin" },
      claudeProfile: { url: "https://profile.test/api/oauth/profile", fetch: answer },
    },
  };
}

const read = (options: RuntimeOptions) =>
  claude.readIdentity({
    account: { tool: "claude", home },
    env: {},
    adapter: { command: "claude-agent-acp", args: [] },
    options,
    timeoutMs: 5_000,
  });

const signIn = (accessToken: string) =>
  writeFile(
    join(home, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken, expiresAt: 1 } }),
  );

describe("Claude sign-in identity", () => {
  it("is who Anthropic says the token belongs to, never what .claude.json claims", async () => {
    const anthropic = profiles({
      "tok-owner": { account: { uuid: "u-owner", email: "owner@acme.test" }, organization: { name: "Acme" } },
      "tok-sam": { account: { uuid: "u-sam", email: "sam@globex.test" }, organization: { name: "Globex" } },
    });
    // The owner's profile left in .claude.json beside another account's token.
    await writeFile(
      join(home, ".claude.json"),
      JSON.stringify({ oauthAccount: { accountUuid: "u-owner", emailAddress: "owner@acme.test" } }),
    );
    await signIn("tok-sam");
    expect(await read(anthropic.options)).toEqual({ id: "u-sam", label: "sam@globex.test, Globex" });
    expect(anthropic.calls).toEqual(["Bearer tok-sam"]);

    await signIn("tok-owner");
    expect(await read(anthropic.options)).toEqual({ id: "u-owner", label: "owner@acme.test, Acme" });
  });

  it("refuses a token Anthropic rejects, a profile it cannot read, and a missing token", async () => {
    const anthropic = profiles({ "tok-odd": { account: { email: "no-uuid@acme.test" } } });
    await signIn("tok-stale");
    await expect(read(anthropic.options)).rejects.toThrow("Anthropic refused this sign-in's token");
    await signIn("tok-odd");
    await expect(read(anthropic.options)).rejects.toThrow("shape majhi does not know");
    await writeFile(join(home, ".credentials.json"), "{}");
    await expect(read(anthropic.options)).rejects.toThrow("no Claude token");
  });
});
