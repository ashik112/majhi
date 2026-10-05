import { scriptProblem } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { readWatch, type WatchPorts } from "./checks.ts";

const ports = (out: string, seen: { connections?: readonly string[] } = {}): WatchPorts =>
  ({
    connection: async (id: string) =>
      id === "do" ? { org: "acme", type: "mcp", name: "DigitalOcean", fields: {}, vars: {} } : undefined,
    script: async (input: { connections: readonly string[] }) => {
      seen.connections = input.connections;
      return out;
    },
  }) as unknown as WatchPorts;

const spec = (fields: Record<string, unknown>) => ({
  kind: "script" as const,
  connections: ["do"],
  ...fields,
});

describe("script watches", () => {
  it("refuses a connection of another workspace", async () => {
    await expect(readWatch(spec({ script: "echo 1" }) as never, "globex", ports("1"))).rejects.toThrow();
  });

  it("lets reads through and refuses scripts that change something", () => {
    for (const ok of [
      'curl -s -H "Authorization: Bearer $DO_TOKEN" "https://api.digitalocean.com/v2/droplets" | jq .meta.total',
      "kubectl get pods -n api -o json",
      "glab mr list --output json",
      'python3 -c "import json,sys; print(42)"',
      "psql -c 'SELECT count(*) FROM orders' > /tmp/out && cat /tmp/out",
    ]) {
      expect(scriptProblem(ok), ok).toBeUndefined();
    }
    for (const bad of [
      "curl -X DELETE https://api.digitalocean.com/v2/droplets/1",
      "curl -d '{}' https://x",
      "kubectl delete pod api-1",
      "kubectl rollout restart deployment/api",
      "glab mr merge 12",
      "rm -rf /data",
      "psql -c 'DROP TABLE orders'",
      'python3 -c "import requests; requests.post(\\"https://x\\")"',
    ]) {
      expect(scriptProblem(bad), bad).toBeDefined();
    }
  });
});
