import { type CrmContact, PRIVATE } from "@majhi/shared";
import type Database from "better-sqlite3";
import { SHIP_KINDS } from "../economics/repo.ts";
import { MAIN_CONTACT_TAGS, type GrowthDeps } from "./ports.ts";

/**
 * What code collects for the growth playbooks, before any model is asked. Every list is short and
 * cut: a prompt carries a few lines of each, never a log or a repo. Titles and notes in here come
 * from tasks, commits, the CRM and the knowledge base, so callers fence them as data.
 */

const SHIP_IN = SHIP_KINDS.map((k) => `'${k}'`).join(", ");

export interface ShippedTask {
  id: string;
  title: string;
  project: string | undefined;
}

/** Tasks of a workspace that shipped in a span, newest first. Chats are not work. */
export function shippedIn(db: Database.Database, org: string, from: string, to: string, limit: number): ShippedTask[] {
  const rows = db
    .prepare(
      `SELECT t.id AS id, t.title AS title, MAX(a.at) AS at,
              (SELECT project FROM task_repos r WHERE r.task = t.id ORDER BY pos LIMIT 1) AS project
         FROM audit a JOIN tasks t ON t.id = a.task
        WHERE COALESCE(a.org, ?) = ? AND a.at >= ? AND a.at < ? AND a.kind IN (${SHIP_IN})
          AND a.decision = 'done' AND t.kind <> 'chat'
        GROUP BY t.id ORDER BY at DESC LIMIT ?`,
    )
    .all(PRIVATE, org, from, to, limit) as { id: string; title: string; project: string | null }[];
  return rows.map((r) => ({ id: r.id, title: r.title, project: r.project ?? undefined }));
}

/** Merge request and pull request links of a workspace's ships in a span. */
export function mergeRequests(db: Database.Database, org: string, from: string, to: string, limit: number): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT a.detail AS detail
         FROM audit a
        WHERE COALESCE(a.org, ?) = ? AND a.at >= ? AND a.at < ? AND a.kind = 'mr' AND a.decision = 'done'
          AND a.detail LIKE 'http%' ORDER BY a.at DESC LIMIT ?`,
    )
    .all(PRIVATE, org, from, to, limit) as { detail: string }[];
  return rows.map((r) => r.detail.split(/\s/)[0] ?? "").filter((d) => d !== "");
}

/** Titles of work not finished yet, most recently touched first. */
export function nextUp(db: Database.Database, org: string, limit: number): string[] {
  const rows = db
    .prepare(
      `SELECT title FROM tasks WHERE COALESCE(org, ?) = ? AND kind <> 'chat' AND status <> 'done'
        ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(PRIVATE, org, limit) as { title: string }[];
  return rows.map((r) => r.title);
}

export interface MainContact {
  contact: CrmContact;
  /** Absent when the contact has no address. */
  email: string | undefined;
}

/**
 * The client's main contact: the CRM contact of this workspace tagged `main-contact`. The captain's
 * view of the CRM applies, so a contact marked owner-only is never chosen.
 */
export function mainContact(deps: GrowthDeps, org: string): MainContact | undefined {
  const { contacts } = deps.crm.list({ org, relation: "client", limit: 200 }, { kind: "captain", org });
  const marked = contacts.filter((c) => c.tags.some((t) => (MAIN_CONTACT_TAGS as readonly string[]).includes(t)));
  const mine = marked.find((c) => c.org === org) ?? marked[0];
  return mine === undefined ? undefined : { contact: mine, email: mine.emails[0] };
}

/** The lines a feed item is matched against: the workspace's active goals, and what the knowledge base says the business does. */
export function keywordLines(deps: GrowthDeps, org: string): string[] {
  const actor = { kind: "captain" as const, org };
  const lines: string[] = [];
  for (const g of deps.goals.list({ org }, actor)) {
    if (g.status === "active") lines.push(`${g.title} ${g.metric ?? ""}`);
  }
  for (const e of deps.kb.list({ org, limit: 100 }, actor).entries) {
    if (["about", "product", "positioning", "win"].includes(e.kind)) lines.push(`${e.title} ${e.tags.join(" ")}`);
  }
  return lines;
}

export interface WeekFacts {
  shipped: ShippedTask[];
  merged: string[];
  risks: string[];
  incidents: string[];
  next: string[];
}

const RISK_SOURCES = new Set(["security", "dependency", "ci", "incident", "log"]);

/** The week's facts for a client update. */
export function weekFacts(deps: GrowthDeps, org: string, now: Date): WeekFacts {
  const to = now.toISOString();
  const from = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const actor = { kind: "captain" as const, org };
  const live = deps.findings.list({ org, status: "live", limit: 200 }, actor).findings;
  const recent = deps.findings.list({ org, source: "incident", limit: 50 }, actor).findings;
  return {
    shipped: shippedIn(deps.db, org, from, to, 12),
    merged: mergeRequests(deps.db, org, from, to, 8),
    risks: live
      .filter((f) => RISK_SOURCES.has(f.source) && f.source !== "incident" && (f.severity === "high" || f.severity === "medium"))
      .slice(0, 5)
      .map((f) => f.title),
    incidents: recent
      .filter((f) => Date.parse(f.lastSeen) >= Date.parse(from))
      .slice(0, 5)
      .map((f) => `${f.title} (${f.status === "fixed" ? "resolved" : "open"})`),
    next: nextUp(deps.db, org, 5),
  };
}
