import type { Task } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { Store } from "./index.ts";

function task(id: string, org: string): Task {
  return {
    id,
    title: `Title ${id}`,
    brief: "brief",
    kind: "code",
    org,
    status: "inbox",
    folder: `/tasks/${id}`,
    repos: [],
    team: [],
    mode: "lead",
    overrides: {},
    links: [],
    attachments: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as Task;
}

const link = (taskId: string, key: string) => ({
  task: taskId,
  type: "jira" as const,
  key,
  url: `https://acme.atlassian.net/browse/${key}`,
  title: "Fix login",
  origin: "pulled" as const,
  status: "To Do",
  stage: null,
  mrs: [],
  syncedAt: "2026-01-01T00:00:00.000Z",
  error: null,
});

describe("tracker links", () => {
  it("finds a link by its org's item, follows an org rename, and goes with its task", () => {
    const store = new Store(":memory:");
    store.tasks.insert(task("ACM-1", "acme"));
    store.tasks.insert(task("GLX-1", "globex"));
    store.trackers.put(link("ACM-1", "ACME-12"));
    store.trackers.put(link("GLX-1", "ACME-12"));
    expect(store.trackers.byKey("acme", "jira", "ACME-12")?.task).toBe("ACM-1");
    expect(store.trackers.byKey("globex", "jira", "ACME-12")?.task).toBe("GLX-1");

    store.tasks.renameOrg("acme", "acme-corp");
    expect(store.trackers.byKey("acme-corp", "jira", "ACME-12")?.task).toBe("ACM-1");
    expect(store.trackers.byKey("acme", "jira", "ACME-12")).toBeUndefined();

    store.tasks.remove("ACM-1");
    expect(store.trackers.get("ACM-1")).toBeUndefined();
    expect(store.trackers.list().map((l) => l.task)).toEqual(["GLX-1"]);
    store.close();
  });

  it("records a write-back without losing what was written before", () => {
    const store = new Store(":memory:");
    store.tasks.insert(task("ACM-1", "acme"));
    store.trackers.put(link("ACM-1", "ACME-12"));
    store.trackers.update(
      "ACM-1",
      { mrs: ["https://github.com/acme/api/pull/9"] },
      "2026-01-02T00:00:00.000Z",
      null,
    );
    store.trackers.update(
      "ACM-1",
      { stage: "review", status: "In Review" },
      "2026-01-03T00:00:00.000Z",
      "Denied",
    );
    expect(store.trackers.get("ACM-1")).toMatchObject({
      mrs: ["https://github.com/acme/api/pull/9"],
      stage: "review",
      status: "In Review",
      syncedAt: "2026-01-03T00:00:00.000Z",
      error: "Denied",
      org: "acme",
    });
    // A bad stored value only means the MR links are written again.
    store.raw.prepare("UPDATE tracker_links SET mrs = 'nope' WHERE task = 'ACM-1'").run();
    expect(store.trackers.get("ACM-1")?.mrs).toEqual([]);
    store.close();
  });
});
