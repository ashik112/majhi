import { describe, expect, it } from "vitest";
import { detectSecrets, replaceSecrets } from "./secrets-detect.ts";

const ANTHROPIC = `sk-ant-api03-${"aB3xY9".repeat(8)}`;
const OPENAI = `sk-proj-${"Qw7Er1".repeat(8)}`;
const GITHUB = `ghp_${"a1B2c3D4e5".repeat(4)}`;
const GITLAB = `glpat-${"Ab12Cd34Ef".repeat(2)}`;
const SLACK = `xoxb-${"1234".repeat(3)}-${"abcDEF".repeat(2)}`;
const AWS = "AKIAIOSFODNN7EXAMPLE";

describe("detectSecrets", () => {
  it("finds a long random token and a value after a keyword", () => {
    expect(detectSecrets("key is Zk3j9Xq2LmN8vB4tR7yU1cW6eH5aS0dF")[0]?.kind).toBe("token");
    const assigned = detectSecrets('export API_KEY="hunter2hunter2X9"');
    expect(assigned[0]).toMatchObject({ kind: "assigned", value: "hunter2hunter2X9" });
  });
});
