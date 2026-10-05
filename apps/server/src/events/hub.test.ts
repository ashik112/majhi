import type { ServerEvent } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { EventHub } from "./hub.ts";

describe("EventHub scopes", () => {
  it("names the tasks that changed, once each, and whether only their workers did", () => {
    const hub = new EventHub();
    const seen: ServerEvent[] = [];
    hub.subscribe((e) => seen.push(e));
    hub.emitTask("ACM-1", true);
    hub.emitTask("ACM-2");
    hub.emit(["tasks"], { tasks: ["ACM-3", "ACM-3"] });
    hub.emit(["tasks"]);
    expect(seen).toEqual([
      { type: "changed", topics: ["tasks"], tasks: ["ACM-1"], rows: true },
      { type: "changed", topics: ["tasks"], tasks: ["ACM-2"] },
      { type: "changed", topics: ["tasks"], tasks: ["ACM-3"] },
      { type: "changed", topics: ["tasks"] },
    ]);
  });
});
