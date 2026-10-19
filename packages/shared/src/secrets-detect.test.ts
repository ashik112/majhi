import { describe, expect, it } from "vitest";
import { detectSecrets, hideSecrets } from "./secrets-detect.ts";

const PRIVATE_KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\ndef\n-----END OPENSSH PRIVATE KEY-----";

describe("detectSecrets", () => {
  it.each([
    ["a private key block", `here:\n${PRIVATE_KEY}\nthanks`, { kind: "private-key", value: PRIVATE_KEY }],
    [
      "a long random token",
      "key is Zk3j9Xq2LmN8vB4tR7yU1cW6eH5aS0dF",
      { kind: "token", value: "Zk3j9Xq2LmN8vB4tR7yU1cW6eH5aS0dF" },
    ],
    [
      "a value after a keyword",
      'export API_KEY="hunter2hunter2X9"',
      { kind: "assigned", value: "hunter2hunter2X9" },
    ],
    ["a commit hash", "commit 9fceb02d0ae598e95dc970b74767f19372d61af8 is fine", undefined],
    ["a sha256", "sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", undefined],
    ["a uuid", "id 3f2504e0-4f89-41d3-9a0c-0305e82c3301", undefined],
    [
      "a path",
      "/Users/owner/Work/majhi/apps/server/src/commands/handlers.ts and src/some/really/deep/folder/name.ts",
      undefined,
    ],
    [
      "a url slug",
      "https://example.com/blog/how-to-write-a-really-long-slug-about-many-things-today",
      undefined,
    ],
    ["a long word", "the word internationalizationLocalizationConfiguration is long", undefined],
    ["a secret reference", "use secret:anthropic-personal for it", undefined],
    ["a placeholder password", "password: changeme", undefined],
    ["a package version", "npm install @modelcontextprotocol/sdk@1.31.0", undefined],
  ] as const)(
    "finds private keys, long tokens and keyword values and leaves hashes, ids and paths alone: %s",
    (_name, text, expected) => {
      const found = detectSecrets(text);
      if (expected === undefined) expect(found, text).toEqual([]);
      else expect(found[0]).toMatchObject(expected);
      // The same finding is what every outlet (command output, logs, approvals, client replies) hides.
      expect(hideSecrets(text, "[hidden]")).toBe(
        expected === undefined ? text : text.replace(expected.value, "[hidden]"),
      );
    },
  );
});
