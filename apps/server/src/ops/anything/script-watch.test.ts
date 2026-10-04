import { scriptProblem, scriptValue } from "@majhi/shared";
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
  it("reads a number, a word, or JSON at a path, with formulas' folding", async () => {
    const seen: { connections?: readonly string[] } = {};
    const cpu = await readWatch(
      spec({ script: "echo 31.4" }) as never,
      "acme",
      ports("31.4\n", seen),
    );
    expect(cpu).toMatchObject({ number: 31.4 });
    expect(seen.connections).toEqual(["do"]);
    const word = await readWatch(spec({ script: "echo active" }) as never,
      "acme",
      ports("active"),
    );
    expect(word).toMatchObject({ signature: "active" });
    const json = await readWatch(
      spec({ script: "curl -s x", path: "data.result.*.values", agg: "max" }) as never,
      "acme",
      ports(
        JSON.stringify({
          data: {
            result: [
              {
                values: [
                  [1, "20"],
                  [2, "85"],
                ],
              },
            ],
          },
        }),
      ),
    );
    expect(json).toMatchObject({ number: 85 });
  });

  it("refuses a connection of another workspace", async () => {
    await expect(
      readWatch( spec({ script: "echo 1" }) as never, "globex", ports("1")),
    ).rejects.toThrow("belongs to another workspace");
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
      "echo x > /etc/passwd",
      "psql -c 'DROP TABLE orders'",
      'python3 -c "import requests; requests.post(\\"https://x\\")"',
    ]) {
      expect(scriptProblem(bad), bad).toBeDefined();
    }
  });

  it("finds no value in empty or non-numeric output it cannot read", () => {
    expect(scriptValue("", {})).toBeUndefined();
    expect(scriptValue('{"a":1}', { path: "b" })).toBeUndefined();
  });
});
