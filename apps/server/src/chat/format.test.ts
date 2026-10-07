import { slackMentions, tokenizeMentions } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { type People, parseBody, renderPlain, renderSlack, renderTelegramHtml } from "./format.ts";

/** One fixed message: bold, code, a link, a list, and a mention with a username and one without. */
const SAMPLE = [
  "Hi @[contact:ct-sara], the **Acme & Globex** build is _live_: run `a < b` now.",
  "See [the notes](https://example.com/n?a=1&b=2).",
  "- first <one>",
  "- second",
  "```\nx > 1 && y\n```",
  "Also @[contact:ct-omar] and @[contact:ct-lee].",
].join("\n\n");

const people: People = (id) =>
  ({
    "ct-sara": { name: "Sara", native: "111", username: "sara_k" },
    "ct-omar": { name: "Omar <O>", native: "222" },
  })[id];

describe("one body, each app's markup", () => {
  const body = parseBody(SAMPLE);

  it("renders to Telegram HTML", () => {
    expect(renderTelegramHtml(body, people)).toBe(
      [
        "Hi @sara_k, the <b>Acme &amp; Globex</b> build is <i>live</i>: run <code>a &lt; b</code> now.",
        'See <a href="https://example.com/n?a=1&amp;b=2">the notes</a>.',
        "• first &lt;one&gt;\n• second",
        "<pre>x &gt; 1 &amp;&amp; y</pre>",
        'Also <a href="tg://user?id=222">Omar &lt;O&gt;</a> and ct-lee.',
      ].join("\n\n"),
    );
  });

  it("renders to Slack mrkdwn, a contact with no id there falling back to its name", () => {
    const slack: People = (id) =>
      id === "ct-sara" ? { name: "Sara", native: "U111" } : people(id) && { name: people(id)?.name ?? "" };
    expect(renderSlack(body, slack)).toBe(
      [
        "Hi <@U111>, the *Acme &amp; Globex* build is _live_: run `a &lt; b` now.",
        "See <https://example.com/n?a=1&amp;b=2|the notes>.",
        "• first &lt;one&gt;\n• second",
        "```\nx &gt; 1 &amp;&amp; y\n```",
        "Also Omar &lt;O&gt; and ct-lee.",
      ].join("\n\n"),
    );
  });

  it("keeps the names in plain words, which the secret scan reads", () => {
    expect(renderPlain(body, people)).toContain("Hi @Sara, the Acme & Globex build is live");
  });

  it("turns a delivered mention into a token and Slack's <@U..> into a mention", () => {
    const text = "ping @sara_k and <@U111> please";
    const found = (m: { native?: string | undefined; username?: string | undefined }) =>
      m.username === "sara_k" || m.native === "U111" ? { id: "ct-sara", name: "Sara" } : undefined;
    const telegram = tokenizeMentions(text, [{ start: 5, end: 12, username: "sara_k" }], found);
    expect(telegram.text).toBe("ping @[contact:ct-sara] and <@U111> please");
    const slack = tokenizeMentions(text, slackMentions(text), found);
    expect(slack.text).toBe("ping @sara_k and @[contact:ct-sara] please");
    expect(slack.names).toEqual({ "ct-sara": "Sara" });
  });
});
