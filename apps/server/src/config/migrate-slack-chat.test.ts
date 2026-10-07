import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { type Harness, harness } from "../testing/harness.ts";

let h: Harness;
afterEach(() => h?.cleanup());

const BOT = "xoxb-1111-2222-fakebottokenvalue";
const APP = "xapp-1-A-2-fakeapptokenvalue";

/** What the Slack setup saved before Slack was a chat app: an `env` connection holding the two tokens by reference. */
describe("moving a saved Slack app to a chat connection", () => {
  it("keeps the token references and the secrets, leaves no env connection named slack, and runs once", async () => {
    h = await harness({ workspaces: false });
    const { secrets, config } = h.majhi.services;
    await secrets.set("slack-bot", BOT);
    await secrets.set("slack-app", APP);
    const file = join(h.env.majhiHome, "majhi.yaml");
    await writeFile(
      file,
      [
        "workspaces: [~/Work]",
        "orgs:",
        "  acme:",
        "    name: Acme",
        "    connections:",
        "      slack:",
        "        type: env",
        "        name: Slack",
        "        description: Slack bot for this workspace.",
        "        agents_off: [laya]",
        "        fields: { service: slack, access: readwrite, account: Acme Team / majhi }",
        "        vars:",
        "          SLACK_BOT_TOKEN: { kind: secret, value: 'secret:slack-bot' }",
        "          SLACK_APP_TOKEN: { kind: secret, value: 'secret:slack-app' }",
        "      sentry:",
        "        type: env",
        "        name: Sentry",
        "        fields: { service: sentry-token }",
        "  globex: { name: Globex }",
        "",
      ].join("\n"),
    );

    expect(await config.migrateSlackChat()).toBe(1);

    const saved = parse(await readFile(file, "utf8")).orgs.acme.connections;
    expect(saved.slack).toEqual({
      type: "chat",
      name: "Slack",
      description: "Slack app for this workspace's client chats. Only majhi reads it.",
      fields: { service: "slack", account: "Acme Team / majhi" },
      vars: {
        SLACK_BOT_TOKEN: { kind: "secret", value: "secret:slack-bot" },
        SLACK_APP_TOKEN: { kind: "secret", value: "secret:slack-app" },
      },
    });
    // Another env connection is not touched, and nobody holds an env connection for Slack any more.
    expect(saved.sentry.type).toBe("env");
    const { orgs } = await config.sections();
    const slackEnv = Object.values(orgs).flatMap((o) =>
      Object.values(o.connections ?? {}).filter((c) => c.type === "env" && c.fields?.service === "slack"),
    );
    expect(slackEnv).toEqual([]);
    // The tokens are the very same secrets: moved by reference, not copied.
    expect(await secrets.get("slack-bot")).toBe(BOT);
    expect(await secrets.get("slack-app")).toBe(APP);
    expect((await secrets.names()).sort()).toEqual(["slack-app", "slack-bot"]);
    expect(await readFile(file, "utf8")).not.toContain(BOT);

    // A second run finds nothing and makes no commit.
    const commits = (await h.log()).length;
    expect(await config.migrateSlackChat()).toBe(0);
    expect((await h.log()).length).toBe(commits);
  });
});
