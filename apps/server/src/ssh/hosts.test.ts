import { describe, expect, it } from "vitest";
import { classifyProbe, type SshRun } from "./hosts.ts";

describe("classifyProbe", () => {
  const out = (code: number | null, output: string): SshRun => ({ code, output });

  it("never returns ssh's own text", () => {
    const secret = "SHA256:abcdefSECRETlooking";
    for (const code of [0, 255, null]) {
      const r = classifyProbe(out(code, `Offering public key ${secret} Permission denied`));
      expect(JSON.stringify(r)).not.toContain(secret);
    }
  });
});
