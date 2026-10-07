import { describe, expect, it } from "vitest";
import { detectSecrets, replaceSecrets } from "./secrets-detect.ts";

const ANTHROPIC = `sk-ant-api03-${"aB3xY9".repeat(8)}`;
const OPENAI = `sk-proj-${"Qw7Er1".repeat(8)}`;
const GITHUB = `ghp_${"a1B2c3D4e5".repeat(4)}`;
const GITLAB = `glpat-${"Ab12Cd34Ef".repeat(2)}`;
const SLACK = `xoxb-${"1234".repeat(3)}-${"abcDEF".repeat(2)}`;
const AWS = "AKIAIOSFODNN7EXAMPLE";

describe("detectSecrets", () => {
  it.each([
    ["anthropic", ANTHROPIC],
    ["openai", OPENAI],
    ["github", GITHUB],
    ["github", `github_pat_${"A1b2C3d4E5".repeat(5)}`],
    ["gitlab", GITLAB],
    ["slack", SLACK],
    ["aws", AWS],
    ["jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"],
  ] as const)("finds a %s key", (kind, value) => {
    const found = detectSecrets(`please use ${value} for the call`);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind, value });
  });

  it("finds a private key block whole", () => {
    const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\ndef\n-----END OPENSSH PRIVATE KEY-----";
    expect(detectSecrets(`here:\n${key}\nthanks`)[0]).toMatchObject({ kind: "private-key", value: key });
  });

  it("finds a long random token and a value after a keyword", () => {
    expect(detectSecrets("key is Zk3j9Xq2LmN8vB4tR7yU1cW6eH5aS0dF")[0]?.kind).toBe("token");
    const assigned = detectSecrets('export API_KEY="hunter2hunter2X9"');
    expect(assigned[0]).toMatchObject({ kind: "assigned", value: "hunter2hunter2X9" });
  });

  it("leaves hashes, uuids, paths, words and references alone", () => {
    const calm = [
      "commit 9fceb02d0ae598e95dc970b74767f19372d61af8 is fine",
      "sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "id 3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      "/Users/owner/Work/majhi/apps/server/src/commands/handlers.ts and src/some/really/deep/folder/name.ts",
      "https://example.com/blog/how-to-write-a-really-long-slug-about-many-things-today",
      "the word internationalizationLocalizationConfiguration is long",
      "use secret:anthropic-personal for it",
      "password: changeme",
      "npm install @modelcontextprotocol/sdk@1.31.0",
    ];
    for (const text of calm) expect(detectSecrets(text), text).toEqual([]);
  });

  it("returns matches in order without overlaps", () => {
    const found = detectSecrets(`${GITHUB} and ${AWS}`);
    expect(found.map((m) => m.kind)).toEqual(["github", "aws"]);
  });
});

describe("replaceSecrets", () => {
  it("swaps each match for its reference", () => {
    const text = `a ${AWS} b ${GITLAB} c`;
    const out = replaceSecrets(text, detectSecrets(text), (m) => `secret:${m.kind}`);
    expect(out).toBe("a secret:aws b secret:gitlab c");
  });
});

describe("detectSecrets and code identifiers", () => {
  it.each([
    "field_name=COUNTER_AUTO_DELIVER_LOG_FIELD",
    "transaction_type__in=COUNTER_SETTLED_TRANSACTION_TYPES",
    "MAX_RETRIES=SOME_CONSTANT",
    "token=settings.API_TOKEN",
    "password = DEFAULT_ADMIN_PASSWORD_VALUE",
    "secret: some_long_config_name_here",
  ])("does not flag %s", (text) => expect(detectSecrets(text), text).toEqual([]));

  it.each([
    ["github", `token = "ghp_${"k3J9m2P7q1".repeat(4)}"`],
    ["openai", `OPENAI=sk-proj-${"Qw7Er1".repeat(8)}`],
    ["aws", "aws_key=AKIAIOSFODNN7EXAMPLE"],
    ["assigned", "api_key=9fceb02d0ae598e95dc970b74767f19372d61af8"],
    ["token", "blob=Zk3j9Xq2LmN8vB4tR7yU1cW6eH5aS0dFgHjK+9Xw=="],
    ["token", "key is Zk3j9Xq2LmN8vB4tR7yU1cW6eH5aS0dF"],
    ["assigned", 'password="hunter2xyz9"'],
    ["assigned", "password='hunter2xyz9'"],
  ] as const)("still flags a %s in %s", (kind, text) => {
    expect(detectSecrets(text).map((m) => m.kind)).toContain(kind);
  });
});
