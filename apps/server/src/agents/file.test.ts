import { describe, expect, it } from "vitest";
import { parseAgentFile, serializeAgent } from "./file.ts";

const VALID = `---
id: builder
scope: acme
role: Builder
account: claude-acme
model: sonnet
where: [anywhere]
---

You build things.
`;

describe("parseAgentFile", () => {
  it("reads frontmatter and instructions, applying defaults", () => {
    const parsed = parseAgentFile("builder.md", VALID);
    expect(parsed).toEqual({
      ok: true,
      agent: {
        frontmatter: {
          id: "builder",
          scope: "acme",
          role: "Builder",
          account: "claude-acme",
          model: "sonnet",
          where: ["anywhere"],
          perms: [],
          tools: [],
          connections: [],
          skills: [],
          origin: "owner",
        },
        instructions: "You build things.\n",
      },
    });
  });

  it("lists every problem in an invalid file", () => {
    const parsed = parseAgentFile(
      "builder.md",
      "---\nid: builder\nscope: acme\nrole: Wizard\nextra: 1\n---\nx",
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("role"),
        expect.stringContaining("account"),
        "extra: Unknown key",
      ]),
    );
  });

  it("rejects a file name that differs from the id", () => {
    const parsed = parseAgentFile("other.md", VALID);
    expect(parsed).toEqual({
      ok: false,
      errors: ['id: The file is other.md, so the id must be "other", not "builder"'],
    });
  });

  it("explains missing or unclosed frontmatter and broken YAML", () => {
    expect(parseAgentFile("a.md", "hello")).toEqual({
      ok: false,
      errors: ["The file must start with a --- line and YAML frontmatter"],
    });
    expect(parseAgentFile("a.md", "---\nid: a\n")).toEqual({
      ok: false,
      errors: ["The frontmatter is not closed with a --- line"],
    });
    const broken = parseAgentFile("a.md", "---\nid: [a\n---\n");
    expect(broken.ok).toBe(false);
  });
});

describe("serializeAgent", () => {
  const full = {
    frontmatter: {
      id: "lead",
      scope: "root",
      role: "Root" as const,
      emoji: "\u{1F9D1}\u200D\u2708\uFE0F",
      account: "claude-personal",
      model: "auto",
      effort: "high",
      tier: { model: "balanced" as const, effort: "middle" as const },
      models: ["opus", "sonnet"],
      where: ["acme", "globex"],
      perms: ["edit" as const, "shell" as const],
      tools: ["git"],
      connections: ["github-acme"],
      skills: ["review"],
      fallback: "backup",
      context: { compact_at: 0.8 },
      turns: { idle: "10m", max_tool_calls: 200 },
      origin: "setup" as const,
    },
    instructions: "Line one.\n\n  Indented: keep # this\n",
  };

  it("round trips exactly, every field and odd instruction text included", () => {
    const text = serializeAgent(full);
    expect(parseAgentFile("lead.md", text)).toEqual({ ok: true, agent: full });
  });

  it("round trips empty and blank-line-leading instructions", () => {
    for (const instructions of ["", "\nstarts blank", "no newline at end"]) {
      const agent = { ...full, instructions };
      expect(parseAgentFile("lead.md", serializeAgent(agent))).toEqual({ ok: true, agent });
    }
  });

  it("writes keys in a stable order", () => {
    const parsed = parseAgentFile("builder.md", VALID);
    if (!parsed.ok) throw new Error("expected a valid file");
    expect(serializeAgent(parsed.agent)).toBe(
      [
        "---",
        "id: builder",
        "scope: acme",
        "role: Builder",
        "account: claude-acme",
        "model: sonnet",
        "where: [anywhere]",
        "perms: []",
        "tools: []",
        "connections: []",
        "skills: []",
        "origin: owner",
        "---",
        "",
        "You build things.",
        "",
      ].join("\n"),
    );
  });
});
