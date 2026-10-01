import type { PermissionAsk } from "@majhi/acp";
import type { RoomItem } from "@majhi/shared";
import { afterEach, describe, expect, it } from "vitest";
import { connectionVerdict, mcpToolOf, withoutUnaskedModes } from "../runs/permissions.ts";
import { taskWorld, type World } from "../testing/world.ts";
import type { GateConnection } from "./gate.ts";

const KUBECONFIG = `apiVersion: v1
kind: Config
clusters: [{ name: c, cluster: { server: "https://prod.acme.example" } }]
contexts: [{ name: prod, context: { cluster: c, user: viewer } }]
users: [{ name: viewer, user: { token: prod-viewer-token-0123456789 } }]
`;

const OPTIONS = [
  { id: "allow", name: "Allow", kind: "allow_once" },
  { id: "always", name: "Allow for this task", kind: "allow_always" },
  { id: "reject", name: "Deny", kind: "reject_once" },
] as const;

function ask(over: Partial<PermissionAsk>): PermissionAsk {
  return { title: "Run", kind: "execute", toolCallId: "t1", options: [...OPTIONS], ...over } as PermissionAsk;
}

describe("connectionVerdict", () => {
  const held: GateConnection[] = [
    { id: "acme-prod", type: "kubectl", context: "acme-prod", allow: [] },
    { id: "acme-newrelic", type: "mcp", server: "acme-newrelic", allow: [] },
  ];

  it("reads a shell command by its line, and an MCP call by its server and tool", () => {
    expect(connectionVerdict(ask({ command: "kubectl get pods" }), held, () => undefined).kind).toBe("read");
    expect(connectionVerdict(ask({ command: "kubectl delete pod x" }), held, () => undefined).kind).toBe(
      "write",
    );
    expect(
      connectionVerdict(
        ask({ kind: "other", title: "mcp__acme-newrelic__list_alerts" }),
        held,
        () => undefined,
      ).kind,
    ).toBe("read");
    // Codex asks about an MCP call without naming it; its tool call's title does.
    const codex = ask({ title: "Permission needed" });
    expect(
      connectionVerdict(codex, held, (id) => (id === "t1" ? "mcp.acme-newrelic.mute_alert" : undefined)).kind,
    ).toBe("write");
    expect(connectionVerdict(ask({ command: "npm test" }), held, () => undefined).kind).toBe("other");
    // A command request that came without its command line is read by its title.
    expect(connectionVerdict(ask({ title: "`kubectl delete pod x`" }), held, () => undefined).kind).toBe(
      "write",
    );
    expect(mcpToolOf("mcp__majhi-room__post")).toEqual({ server: "majhi-room", tool: "post" });
  });

  it("drops the choices that would make the CLI stop asking", () => {
    const options = withoutUnaskedModes([
      { id: "exit-plan-auto", name: "Auto", kind: "allow_always" },
      { id: "exit-plan-clear-bypass", name: "Bypass", kind: "allow_always" },
      { id: "exit-plan-accept-edits", name: "Edits", kind: "allow_always" },
      { id: "exit-plan-default", name: "Ask", kind: "allow_once" },
    ]);
    expect(options.map((o) => o.id)).toEqual(["exit-plan-accept-edits", "exit-plan-default"]);
  });
});

describe("the gate in a run", () => {
  let w: World;
  afterEach(() => w?.cleanup());

  async function items(task: string): Promise<RoomItem[]> {
    const page = await w.h.cmd("room.items", { task, limit: 500 });
    return [...(page.body.items as RoomItem[])].sort((a, b) => (a.at < b.at ? -1 : 1));
  }
  async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
    for (let i = 0; i < 400; i++) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`Timed out waiting for ${what}`);
  }

  it("lets reads run, asks for writes even with the shell perm, and logs each write", async () => {
    w = await taskWorld({ agent: { connections: ["acme-prod"], perms: ["edit", "shell"] } });
    const must = async (name: string, body: unknown) => {
      const res = await w.h.cmd(name, body);
      if (res.status !== 200) throw new Error(`${name}: ${JSON.stringify(res.body)}`);
      return res.body;
    };
    await must("connections.create", {
      org: "acme",
      id: "acme-prod",
      type: "kubectl",
      name: "Acme prod",
      fields: { context: "prod" },
    });
    const form = new FormData();
    form.append("file", new File([KUBECONFIG], "config"), "config");
    const upload = (await (
      await w.h.majhi.app.request("/api/uploads?for=connection", { method: "POST", body: form })
    ).json()) as { id: string };
    await must("connections.setFile", { id: "acme-prod", field: "kubeconfig", upload: upload.id });
    await must("connections.allow", { id: "acme-prod", allow: ["kubectl rollout restart deployment/web"] });

    const answers: (string | undefined)[] = [];
    w.h.runtime.onSession = (session) => {
      if (w.h.runtime.sessions.length > 0) return;
      session.script = async (turn) => {
        answers.push(await turn.ask(ask({ command: "kubectl get pods -n api", toolCallId: "a" })));
        answers.push(
          await turn.ask(ask({ command: "kubectl rollout restart deployment/web", toolCallId: "b" })),
        );
        answers.push(
          await turn.ask(ask({ command: "kubectl rollout restart deployment/api", toolCallId: "c" })),
        );
        answers.push(
          await turn.ask(
            ask({
              kind: "switch_mode",
              title: "Ready to code?",
              toolCallId: "d",
              options: [
                { id: "exit-plan-bypass", name: "Bypass", kind: "allow_always" },
                { id: "exit-plan-default", name: "Ask", kind: "allow_once" },
                { id: "reject", name: "No", kind: "reject_once" },
              ],
            }),
          ),
        );
        return "end_turn";
      };
    };
    const task = (await must("tasks.create", {
      text: "restart the api, repo api",
      repos: [{ project: "acme-api" }],
      kind: "ops",
      start: true,
    })) as {
      id: string;
    };

    const pending = async () =>
      (await items(task.id)).filter(
        (i): i is Extract<RoomItem, { type: "permission" }> =>
          i.type === "permission" && i.state === "pending",
      );
    await until(async () => (await pending()).length === 1, "the restart prompt");
    const [restart] = await pending();
    expect(answers).toEqual(["allow", "allow"]);
    expect(restart?.connection).toEqual({
      id: "acme-prod",
      name: "Acme prod",
      action: "kubectl rollout restart deployment/api",
      why: "kubectl rollout restart changes the cluster",
    });
    // Allow counts once: no choice that the CLI would remember.
    expect(restart?.options.map((o) => o.id)).toEqual(["allow", "reject"]);
    expect(
      (await must("room.permission", { task: task.id, item: restart?.id, option: "allow" })) as unknown,
    ).toBeTruthy();

    await until(async () => (await pending()).length === 1 && answers.length === 3, "the plan prompt");
    const [plan] = await pending();
    expect(plan?.options.map((o) => o.id)).toEqual(["exit-plan-default", "reject"]);
    await must("room.permission", { task: task.id, item: plan?.id, option: "reject" });
    await w.h.majhi.services.runs.idle(task.id);

    const audit = w.h.majhi.services.store.permissions
      .audit(task.id)
      .filter((r) => r.kind === "connection-write")
      .map((r) => [r.decision, r.by, r.detail, r.org]);
    expect(audit).toEqual(
      expect.arrayContaining([
        ["allow", "rule", "acme-prod: kubectl rollout restart deployment/web", "acme"],
        ["allow", "owner", "acme-prod: kubectl rollout restart deployment/api", "acme"],
      ]),
    );
    expect(w.h.majhi.services.store.permissions.allowed(task.id, "execute")).toBe(false);

    // A background process does not get around it.
    await expect(
      w.h.majhi.services.processes.start({
        task: task.id,
        agent: "acme-builder",
        command: "kubectl delete pod api-7d9",
        wait: true,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
});
