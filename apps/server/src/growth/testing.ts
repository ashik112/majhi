import { type KbUpsertInput, KbUpsertInputSchema, PlaybookSchema, PRIVATE } from "@majhi/shared";
import { CrmService } from "../business/crm.ts";
import { DeadlinesService } from "../business/deadlines.ts";
import { KbService } from "../business/kb.ts";
import { VoiceService } from "../business/voice.ts";
import { FindingsRepo } from "../findings/repo.ts";
import { FindingsService } from "../findings/service.ts";
import { BUILTIN } from "../playbooks/catalog.ts";
import { GoalsService } from "../playbooks/goals.ts";
import { OutboundGate } from "../playbooks/outbound.ts";
import type { RulesContext } from "../playbooks/rules.ts";
import { CardRepo } from "../projectcard/repo.ts";
import { SensorCache } from "../sensors/cache.ts";
import { Store } from "../store/index.ts";
import type { GrowthDeps, Writer } from "./ports.ts";

/** Test pieces for the growth playbooks: every service over one in-memory store, and a clock of ours. */

export const T0 = new Date("2026-10-09T15:00:00.000Z");
const ORGS = new Set(["acme", "globex", PRIVATE]);

export interface Desk {
  deps: GrowthDeps;
  store: Store;
  clock: { at: Date };
  /** Every prompt the model was asked, newest last. */
  prompts: string[];
  /** What the model says next; a function to throw, or a string. Empty: no model is set. */
  model: { reply: string | (() => string) | undefined };
  sent: { n: number };
  findings: FindingsService;
  ctx(id: string, org?: string, over?: Partial<RulesContext>): RulesContext;
  task(id: string, title: string, over?: { org?: string; kind?: string; status?: string }): void;
  ship(task: string, at: Date, over?: { kind?: string; by?: string; detail?: string; org?: string }): void;
  kb(over: Partial<KbUpsertInput>): Promise<void>;
}

export function desk(over: { write?: Writer } = {}): Desk {
  const store = new Store(":memory:");
  const db = store.raw;
  const clock = { at: new Date(T0) };
  const now = () => clock.at;
  const orgExists = async (org: string) => ORGS.has(org);
  const findings = new FindingsService({
    repo: new FindingsRepo(db),
    now,
    projectOrg: async (id) =>
      id.startsWith("acme") ? "acme" : id.startsWith("globex") ? "globex" : undefined,
    taskStatus: () => undefined,
    createTask: async () => ({ id: "ACM-100" }),
  });
  const crm = new CrmService({ db, now, orgExists });
  const sent = { n: 0 };
  const outbound = new OutboundGate({
    db,
    now,
    tz: async () => "UTC",
    knownOrg: orgExists,
    transports: {
      email: {
        send: async () => {
          sent.n += 1;
          return { ok: true, detail: "sent" };
        },
      },
    },
  });
  const prompts: string[] = [];
  const model: Desk["model"] = { reply: undefined };
  const write: Writer =
    over.write ??
    (async (_task, prompt, parse) => {
      prompts.push(prompt);
      const raw = typeof model.reply === "function" ? model.reply() : model.reply;
      if (raw === undefined) return undefined;
      const parsed = parse(raw);
      if (!parsed.ok) throw new Error(`did not give a valid answer: ${parsed.problem}`);
      return parsed.value;
    });
  const kb = new KbService({
    db,
    now,
    takeUpload: async (id) => ({ id, kind: "file", name: id, path: id }),
    filesDir: (entry) => `/files/${entry}`,
    orgExists,
  });
  const deps: GrowthDeps = {
    db,
    now,
    findings,
    kb,
    voice: new VoiceService({ db, now, orgExists }),
    crm,
    deadlines: new DeadlinesService({
      db,
      now,
      orgExists,
      contactVisible: (id, actor) => crm.exists(id, actor),
      findingExists: (id) => findings.exists(id),
    }),
    goals: new GoalsService({ db, now, knownOrg: orgExists }),
    cards: new CardRepo(db),
    outbound,
    cache: new SensorCache(db),
    orgName: async (org) => (org === "acme" ? "Acme" : org === "globex" ? "Globex" : "Private"),
    write,
  };
  return {
    deps,
    store,
    clock,
    prompts,
    model,
    sent,
    findings,
    ctx(id, org = "acme", extra = {}) {
      const def = BUILTIN.find((p) => p.id === id);
      if (def === undefined) throw new Error(`no playbook ${id}`);
      return {
        org,
        playbook: PlaybookSchema.parse(def),
        settings: {},
        findings,
        now,
        fetch: (async () => {
          throw new Error("this playbook uses its own network");
        }) as typeof fetch,
        ...extra,
      };
    },
    task(id, title, o = {}) {
      const at = clock.at.toISOString();
      db.prepare(
        `INSERT INTO tasks (id, title, brief, kind, org, status, folder, team, created_at, updated_at)
         VALUES (?, ?, '', ?, ?, ?, 'x', '[]', ?, ?)`,
      ).run(
        id,
        title,
        o.kind ?? "code",
        o.org === PRIVATE ? null : (o.org ?? "acme"),
        o.status ?? "done",
        at,
        at,
      );
    },
    ship(task, at, o = {}) {
      db.prepare(
        `INSERT INTO audit (task, agent, kind, title, decision, by, at, detail, org)
         VALUES (?, 'owner', ?, 'Ship', 'done', ?, ?, ?, ?)`,
      ).run(task, o.kind ?? "merge", o.by ?? "owner", at.toISOString(), o.detail ?? "main", o.org ?? "acme");
    },
    async kb(o) {
      await deps.kb.upsert(
        KbUpsertInputSchema.parse({
          kind: "product",
          title: "Acme storefront",
          body: "A shop for boats.",
          ...o,
        }),
        { kind: "owner" },
      );
    },
  };
}

export const DAY = 86_400_000;
export const daysAgo = (n: number): Date => new Date(T0.getTime() - n * DAY);
