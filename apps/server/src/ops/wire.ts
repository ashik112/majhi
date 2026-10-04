import type { Draft, NotificationsSettings, OwnerDecision } from "@majhi/shared";
import type Database from "better-sqlite3";
import type { ConnectionTester } from "../connections/tester.ts";
import type { FindingsService } from "../findings/service.ts";
import { inQuietHours } from "../notify/attention.ts";
import type { Notifier } from "../notify/service.ts";
import { PhoneChannel, SECRET_KEY, type SecretsPort } from "./phone.ts";
import { numberAt, type ProbePorts, systemPorts } from "./probes.ts";
import { OpsRepo } from "./repo.ts";
import { PhoneTokens } from "./tokens.ts";
import { OpsWatch } from "./watch.ts";

/** The pieces the ops watch needs from the rest of majhi, as small ports. */
export interface OpsWiring {
  db: Database.Database;
  findings: FindingsService;
  secrets: SecretsPort;
  notifier: Notifier;
  /** News for a workspace's captain lane. */
  wake: (org: string, text: string) => void;
  orgName: (org: string) => Promise<string>;
  projectOrg: (project: string) => Promise<string | undefined>;
  connections: {
    /** The workspace's connections: id, name, type. */
    list: (org: string) => Promise<{ id: string; name: string; type: string }[]>;
    /** The workspace a connection belongs to. */
    orgOf: (id: string) => Promise<string | undefined>;
  };
  tester: Pick<ConnectionTester, "callRemoteTool">;
  inbox: {
    list(): Promise<OwnerDecision[]>;
    answer(input: { id: string; option: string }): Promise<unknown>;
  };
  drafts: (org: string) => Draft[];
  notifications: () => Promise<NotificationsSettings>;
  /** False when this machine has no network. */
  online: () => Promise<boolean>;
  changed: () => void;
  now?: () => Date;
  /** For tests: the network behind the checks, the ntfy server, and the wait between two looks. */
  probes?: Partial<ProbePorts>;
  ntfyFetch?: typeof fetch;
  retryMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface Ops {
  watch: OpsWatch;
  phone: PhoneChannel;
  repo: OpsRepo;
  tokens: PhoneTokens;
  /** Starts the half-minute tick. */
  start(): void;
  close(): void;
}

export const TICK_MS = 30_000;

export function createOps(w: OpsWiring): Ops {
  const repo = new OpsRepo(w.db);
  const now = w.now ?? (() => new Date());
  const tokens = new PhoneTokens(
    repo,
    async () => {
      const key = await w.secrets.get(SECRET_KEY);
      return key === undefined ? undefined : Buffer.from(key, "base64");
    },
    now,
  );
  const phone = new PhoneChannel({
    repo,
    secrets: w.secrets,
    tokens,
    fetch: w.ntfyFetch ?? fetch,
    now,
    orgName: async (org) => (org === undefined ? "majhi" : w.orgName(org)),
    inQuiet: async () => {
      const n = await w.notifications();
      return inQuietHours(now().getTime(), { from: n.quiet_from, to: n.quiet_to, tz: n.quiet_tz });
    },
    decisions: w.inbox,
    // The watch is built below; an acknowledgement only comes from a later request.
    ack: (id) => watch.ack(id),
    changed: w.changed,
  });
  const ports: ProbePorts = {
    ...systemPorts({
      fetch: w.probes?.fetch ?? fetch,
      now,
      monitor: async (org, m) => {
        if ((await w.connections.orgOf(m.connection)) !== org) {
          return { state: "unavailable", why: "the connection is not in this workspace" };
        }
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(m.args) as Record<string, unknown>;
        } catch {
          return { state: "unavailable", why: "the arguments are not JSON" };
        }
        try {
          const answer = await w.tester.callRemoteTool(m.connection, m.tool, args);
          const value = numberAt(answer, m.path);
          return value === undefined
            ? { state: "unavailable", why: "no number at that path" }
            : { state: "ok", value };
        } catch {
          return { state: "unavailable", why: "the connection did not answer" };
        }
      },
    }),
    ...w.probes,
  };
  const watch: OpsWatch = new OpsWatch({
    repo,
    findings: w.findings,
    ports,
    phone,
    notify: async (n) => {
      if (n.severity === "low") return;
      await w.notifier.incident({ id: n.id, text: n.text, severity: n.severity, repeat: n.repeat });
    },
    wake: w.wake,
    orgName: w.orgName,
    projectOrg: w.projectOrg,
    connections: async (org) =>
      (await w.connections.list(org)).filter((c) => c.type === "mcp").map((c) => c.name),
    actionLines: async (finding) => {
      const f = w.findings.get(finding);
      const lines: string[] = [];
      if (f.task !== undefined) {
        lines.push(`${f.status === "proposed" ? "Fix task proposed" : "Fix task started"}: ${f.task}`);
      }
      for (const d of w.drafts(f.org)) {
        if (d.finding === finding) lines.push(`Status update drafted for ${d.channel}`);
      }
      return lines;
    },
    online: w.online,
    ...(w.sleep === undefined ? {} : { sleep: w.sleep }),
    ...(w.retryMs === undefined ? {} : { retryMs: w.retryMs }),
    now,
    changed: w.changed,
  });
  let timer: NodeJS.Timeout | undefined;
  return {
    watch,
    phone,
    repo,
    tokens,
    start() {
      timer ??= setInterval(() => void watch.tick().catch(() => undefined), TICK_MS);
      timer.unref();
    },
    close() {
      clearInterval(timer);
      timer = undefined;
    },
  };
}
