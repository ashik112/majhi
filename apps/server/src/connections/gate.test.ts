import { describe, expect, it } from "vitest";
import { classifyCommand, type GateConnection } from "./gate.ts";

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
  it.each<[line: string, kind: "read" | "write"]>([
    ["echo $(kubectl delete pod api-7d9)", "write"],
    ["echo `kubectl delete ns api`", "write"],
    ['echo "pods: $(kubectl scale deploy/api --replicas=0)"', "write"],
    ['sh -c "kubectl delete pod api-7d9"', "write"],
    ["bash -lc 'kubectl get pods'", "read"],
    ['eval "kubectl scale deploy/api --replicas=0"', "write"],
    ["watch kubectl get pods", "read"],
    ['watch -n 5 "kubectl delete pod api-7d9"', "write"],
    ["kubectl get pods -o name | xargs kubectl delete", "write"],
    ["kubectl get pods -o name | xargs -I{} kubectl delete {}", "write"],
    ["timeout 30 kubectl delete pod api-7d9", "write"],
    ["find . -name '*.yaml' -exec kubectl apply -f {} \\;", "write"],
    ["$KUBECTL delete pod api-7d9", "write"],
    ['"$(which kubectl)" get pods', "write"],
    ['kubectl get "pods', "write"],
  ])(
    "reads inside $(...), backticks, sh -c, eval, watch, xargs and find -exec, and counts what it cannot read as a write: %s is a %s",
    (line, expected) => {
      expect(kind(line)).toBe(expected);
    },
  );
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

describe("copies of a repo", () => {
  const gitlab: GateConnection = { id: "acme-gitlab", type: "git", clis: ["glab", "gh", "git"], allow: [] };
  it.each<[line: string, kind: "read" | "write" | "other"]>([
    [
      "D=$(mktemp -d); cd $D && glab repo clone acme/shop gl -- --bare -q 2>&1 | tail -3; cd gl; git fetch -q https://example.com/acme/shop.git main:refs/gh/main 2>&1|tail -2; git log --oneline -3 main; git diff --stat main refs/gh/main | tail -3",
      "other",
    ],
    ["gh repo clone acme/shop shop", "read"],
    ["git clone --bare git@example.com:acme/shop.git shop.git", "read"],
    ["glab repo clone acme/shop gl -- --upload-pack='touch /tmp/x'", "write"],
    ["gh repo clone acme/shop shop -- -c core.sshCommand='touch /tmp/x'", "write"],
    ["git clone -u 'touch /tmp/x' git@example.com:acme/shop.git", "write"],
    ["git fetch --upload-pack=evil origin", "write"],
    ["git clone --config core.hooksPath=/tmp git@example.com:acme/shop.git", "write"],
    ["git push gitlab main", "write"],
    ["glab repo delete acme/shop", "write"],
  ])("a copy into a scratch folder reads, unless a flag runs a program: %s is a %s", (line, expected) => {
    expect(kind(line, [gitlab])).toBe(expected);
  });
});
