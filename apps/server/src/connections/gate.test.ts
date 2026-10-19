import { describe, expect, it } from "vitest";
import { classifyCommand, classifyRemote, classifyTool, type GateConnection } from "./gate.ts";

const prod: GateConnection = {
  id: "acme-prod",
  type: "kubectl",
  context: "acme-prod",
  allow: ["kubectl rollout restart deployment/api"],
};
const staging: GateConnection = { id: "acme-staging", type: "kubectl", context: "acme-staging", allow: [] };
const aws: GateConnection = { id: "acme-aws", type: "env", clis: ["aws"], allow: [] };
const newrelic: GateConnection = {
  id: "acme-newrelic",
  type: "mcp",
  server: "acme-newrelic",
  readTools: ["execute_nrql_query"],
  writeTools: ["list_and_reset_alerts"],
  allow: ["mute_alert"],
};
const mail: GateConnection = { id: "acme-mail", type: "mail", allow: [] };
const held = [prod, staging, aws, newrelic, mail];

const kind = (line: string, connections: readonly GateConnection[] = held) =>
  classifyCommand(line, connections).kind;

describe("classifyCommand: whole lines", () => {
  it("reads inside $(...), backticks, sh -c, eval, watch, xargs and find -exec", () => {
    expect(kind("echo $(kubectl delete pod api-7d9)")).toBe("write");
    expect(kind("echo `kubectl delete ns api`")).toBe("write");
    expect(kind('echo "pods: $(kubectl scale deploy/api --replicas=0)"')).toBe("write");
    expect(kind('sh -c "kubectl delete pod api-7d9"')).toBe("write");
    expect(kind("bash -lc 'kubectl get pods'")).toBe("read");
    expect(kind('eval "kubectl scale deploy/api --replicas=0"')).toBe("write");
    expect(kind("watch kubectl get pods")).toBe("read");
    expect(kind('watch -n 5 "kubectl delete pod api-7d9"')).toBe("write");
    expect(kind("kubectl get pods -o name | xargs kubectl delete")).toBe("write");
    expect(kind("kubectl get pods -o name | xargs -I{} kubectl delete {}")).toBe("write");
    expect(kind("timeout 30 kubectl delete pod api-7d9")).toBe("write");
    expect(kind("find . -name '*.yaml' -exec kubectl apply -f {} \\;")).toBe("write");
  });
});

describe("destructive writes", () => {
  it("asks for kubectl delete even when allow holds the exact command", () => {
    const allowed: GateConnection = { ...prod, allow: ["kubectl delete pod api-7d9"] };
    expect(classifyCommand("kubectl delete pod api-7d9", [allowed])).toMatchObject({
      kind: "write",
      writes: [{ action: "kubectl delete pod api-7d9", destructive: true, allowed: false }],
    });
  });
});
