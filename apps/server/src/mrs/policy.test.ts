import { describe, expect, it } from "vitest";
import { type MergeQuery, NO_CI_GRACE_MS, nextMerge, type RepoMrState } from "./policy.ts";

const NOW = Date.parse("2026-01-01T12:00:00Z");
const long = "2026-01-01T11:00:00Z";
const repo = (
  project: string,
  state: "open" | "merged" | "closed",
  ci: "none" | "pending" | "passing" | "failing",
  pushedAt = long,
): RepoMrState => ({ project, mr: { state, ci }, pushedAt });
const ask = (q: Partial<MergeQuery> & Pick<MergeQuery, "order">) =>
  nextMerge({ policy: "approve", trigger: "owner", nowMs: NOW, ...q });

describe("nextMerge", () => {
  describe("never", () => {
    it("merges nothing, whoever asks", () => {
      for (const trigger of ["owner", "poll"] as const) {
        expect(ask({ policy: "never", trigger, order: [repo("api", "open", "passing")] }).action).toBe(
          "wait",
        );
      }
    });
  });

  describe("approve", () => {
    it("waits for the owner's click when polled, and merges on the click", () => {
      const order = [repo("api", "open", "passing")];
      expect(ask({ trigger: "poll", order }).action).toBe("wait");
      expect(ask({ trigger: "owner", order })).toEqual({ action: "merge", project: "api" });
    });

    it("stops on failing CI and says which repo", () => {
      const d = ask({ order: [repo("api", "merged", "passing"), repo("web", "open", "failing")] });
      expect(d).toMatchObject({ action: "stop", project: "web" });
      expect((d as { reason: string }).reason).toContain("CI failed on web");
    });

    it("stops, rather than waits, while CI runs, since the owner's click ends the call", () => {
      expect(ask({ order: [repo("api", "open", "pending")] }).action).toBe("stop");
    });
  });

  describe("auto-if-green", () => {
    const auto = (order: RepoMrState[]) => ask({ policy: "auto-if-green", trigger: "poll", order });

    it("merges when CI passes", () => {
      expect(auto([repo("api", "open", "passing")])).toEqual({ action: "merge", project: "api" });
    });

    it("waits while CI runs and stops when it fails", () => {
      expect(auto([repo("api", "open", "pending")]).action).toBe("wait");
      expect(auto([repo("api", "open", "failing")]).action).toBe("stop");
    });

    it("does not merge a later repo before an earlier one", () => {
      expect(auto([repo("api", "open", "pending"), repo("web", "open", "passing")])).toMatchObject({
        action: "wait",
        project: "api",
      });
    });

    it("gives checks time to appear before it counts none as green", () => {
      const fresh = new Date(NOW - NO_CI_GRACE_MS + 1000).toISOString();
      expect(auto([repo("api", "open", "none", fresh)]).action).toBe("wait");
      expect(auto([repo("api", "open", "none", long)]).action).toBe("merge");
      expect(auto([{ project: "api", mr: { state: "open", ci: "none" } }]).action).toBe("wait");
    });
  });
});
