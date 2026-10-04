import {
  type CrmConflict,
  type CrmContact,
  CrmContactSchema,
  type CrmGet,
  type CrmInteraction,
  type CrmList,
  type CrmListInput,
  type CrmNextSteps,
  type CrmUpsertInput,
  type CrmUpsertResult,
} from "@majhi/shared";
import type Database from "better-sqlite3";
import { UserError } from "../errors.ts";
import {
  actorBy,
  type BusinessActor,
  canChange,
  canSee,
  cleanTags,
  likePattern,
  missing,
  orgWhere,
  parseList,
  targetOrg,
} from "./scope.ts";

/**
 * The light CRM (SPEC 5.19): people and organisations, what happened with them, the next step and
 * its due day. A contact has one home: a workspace or the whole business. The same email or link in
 * the same home is the same contact. Personal data stays on this machine and out of every log: error
 * messages here name ids, never the data.
 */

interface Row {
  id: number;
  org: string | null;
  kind: string;
  relation: string;
  name: string;
  company: string;
  role: string;
  links: string;
  emails: string;
  notes: string;
  tags: string;
  owner_only: number;
  stage: string | null;
  next_step: string;
  next_due: string | null;
  last_touch: string | null;
  by: string;
  created_at: string;
  updated_at: string;
}

interface InteractionRow {
  id: number;
  contact: number;
  at: string;
  channel: string;
  summary: string;
  link: string | null;
  by: string;
}

export interface CrmDeps {
  db: Database.Database;
  now?: () => Date;
  orgExists: (org: string) => Promise<boolean>;
  changed?: () => void;
}

const NOTES_MAX = 8_000;
const INTERACTIONS_SHOWN = 100;

/** The key an email is known by: lower case. */
export function emailKey(email: string): string {
  return `e:${email.trim().toLowerCase()}`;
}

/** The key a link is known by: no scheme, no `www.`, no query, hash or trailing slash, lower case. */
export function linkKey(link: string): string {
  const bare = link
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "");
  return `l:${bare}`;
}

function toContact(r: Row): CrmContact {
  return CrmContactSchema.parse({
    id: r.id,
    kind: r.kind,
    relation: r.relation,
    name: r.name,
    company: r.company,
    role: r.role,
    links: parseList(r.links),
    emails: parseList(r.emails),
    notes: r.notes,
    tags: parseList(r.tags),
    ...(r.org === null ? {} : { org: r.org }),
    ownerOnly: r.owner_only === 1,
    ...(r.stage === null ? {} : { stage: r.stage }),
    nextStep: r.next_step,
    ...(r.next_due === null ? {} : { nextDue: r.next_due }),
    ...(r.last_touch === null ? {} : { lastTouch: r.last_touch }),
    by: r.by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });
}

function toInteraction(r: InteractionRow): CrmInteraction {
  return {
    id: r.id,
    contact: r.contact,
    at: r.at,
    channel: r.channel as CrmInteraction["channel"],
    summary: r.summary,
    ...(r.link === null ? {} : { link: r.link }),
    by: r.by,
  };
}

function union(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a, ...b])];
}

/** The fields a merge carries from one contact to another. */
type Fields = Omit<CrmContact, "id" | "createdAt" | "updatedAt" | "by">;

/**
 * Folds `other` into `keep`. The kept contact's filled fields win; an empty one takes the other's. Lists
 * join, notes join, owner-only sticks. A field both fill with different text is reported as a conflict
 * and the kept value stays.
 */
export function enrich(keep: Fields, other: Fields): { fields: Fields; conflicts: CrmConflict[] } {
  const conflicts: CrmConflict[] = [];
  const pick = <T extends string>(field: string, a: T, b: T, empty: (v: T) => boolean): T => {
    if (empty(a)) return b;
    if (!empty(b) && a.trim().toLowerCase() !== b.trim().toLowerCase())
      conflicts.push({ field, kept: a, other: b });
    return a;
  };
  const blank = (v: string) => v.trim() === "";
  const name = pick("name", keep.name, other.name, blank);
  const company = pick("company", keep.company, other.company, blank);
  const role = pick("role", keep.role, other.role, blank);
  const relation = pick("relation", keep.relation, other.relation, (v) => v === "other");
  const kind = keep.kind;
  const stage = pick("stage", keep.stage ?? "", other.stage ?? "", blank);
  const nextStep = pick("nextStep", keep.nextStep, other.nextStep, blank);
  const nextDue = pick("nextDue", keep.nextDue ?? "", other.nextDue ?? "", blank);
  const notesOther = other.notes.trim();
  const notes =
    notesOther === "" || keep.notes.includes(notesOther)
      ? keep.notes
      : `${keep.notes.trim() === "" ? "" : `${keep.notes.trim()}\n\n`}${notesOther}`.slice(0, NOTES_MAX);
  const lastTouch = [keep.lastTouch, other.lastTouch]
    .filter((x): x is string => x !== undefined)
    .sort()
    .at(-1);
  return {
    conflicts,
    fields: {
      kind,
      relation: relation as Fields["relation"],
      name,
      company,
      role,
      links: union(keep.links, other.links),
      emails: union(keep.emails, other.emails),
      notes,
      tags: union(keep.tags, other.tags),
      ...(keep.org === undefined ? {} : { org: keep.org }),
      ownerOnly: keep.ownerOnly || other.ownerOnly,
      ...(stage === "" ? {} : { stage: stage as NonNullable<Fields["stage"]> }),
      nextStep,
      ...(nextDue === "" ? {} : { nextDue }),
      ...(lastTouch === undefined ? {} : { lastTouch }),
    },
  };
}

function fieldsOf(c: CrmContact): Fields {
  const { id: _id, createdAt: _c, updatedAt: _u, by: _by, ...rest } = c;
  return rest;
}

function inputFields(input: CrmUpsertInput, org: string | null, ownerOnly: boolean): Fields {
  return {
    kind: input.kind,
    relation: input.relation,
    name: input.name,
    company: input.company,
    role: input.role,
    links: input.links,
    emails: input.emails,
    notes: input.notes,
    tags: cleanTags(input.tags),
    ...(org === null ? {} : { org }),
    ownerOnly,
    ...(input.stage === undefined ? {} : { stage: input.stage }),
    nextStep: input.nextStep,
    ...(input.nextDue === undefined ? {} : { nextDue: input.nextDue }),
  };
}

/** The local calendar day of a moment, `2026-11-20`. */
export function dayOf(date: Date): string {
  const p = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(
    date,
  );
  return p;
}

export class CrmService {
  private readonly db: Database.Database;

  constructor(private readonly deps: CrmDeps) {
    this.db = deps.db;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private at(): string {
    return this.now().toISOString();
  }

  private row(id: number): Row | undefined {
    return this.db.prepare("SELECT * FROM crm_contacts WHERE id = ?").get(id) as Row | undefined;
  }

  /** What the actor may read of a contact: the captain and agents never see owner-only ones. */
  private readable(actor: BusinessActor, r: Row): boolean {
    return canSee(actor, r.org) && (actor.kind === "owner" || r.owner_only === 0);
  }

  private visible(id: number, actor: BusinessActor): Row {
    const found = this.row(id);
    if (found === undefined || !this.readable(actor, found)) throw missing("Contact", id);
    return found;
  }

  /** Whether the actor may link to this contact (a deadline does). */
  exists(id: number, actor: BusinessActor): boolean {
    const found = this.row(id);
    return found !== undefined && this.readable(actor, found);
  }

  private visibleSql(
    actor: BusinessActor,
    filter: { org?: string | undefined; businessOnly?: boolean | undefined },
  ) {
    const scope = orgWhere("org", actor, filter);
    const parts = [scope.sql];
    if (actor.kind !== "owner") parts.push("owner_only = 0");
    return { parts, args: [...scope.args] as unknown[] };
  }

  list(input: CrmListInput, actor: BusinessActor): CrmList {
    const { parts, args } = this.visibleSql(actor, input);
    if (input.relation !== undefined) {
      parts.push("relation = ?");
      args.push(input.relation);
    }
    if (input.stage !== undefined) {
      parts.push("stage = ?");
      args.push(input.stage);
    }
    if (input.tag !== undefined) {
      parts.push("EXISTS (SELECT 1 FROM json_each(crm_contacts.tags) WHERE value = ?)");
      args.push(input.tag.toLowerCase());
    }
    if (input.query !== undefined && input.query !== "") {
      const like = likePattern(input.query);
      parts.push(
        "(name LIKE ? ESCAPE '\\' OR company LIKE ? ESCAPE '\\' OR emails LIKE ? ESCAPE '\\' OR links LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' OR role LIKE ? ESCAPE '\\')",
      );
      args.push(like, like, like, like, like, like, like);
    }
    const where = parts.join(" AND ");
    const total = (
      this.db.prepare(`SELECT count(*) AS n FROM crm_contacts WHERE ${where}`).get(...args) as { n: number }
    ).n;
    const rows = this.db
      .prepare(`SELECT * FROM crm_contacts WHERE ${where} ORDER BY name COLLATE NOCASE, id LIMIT ?`)
      .all(...args, input.limit) as Row[];
    return { contacts: rows.map(toContact), total };
  }

  get(id: number, actor: BusinessActor): CrmGet {
    const r = this.visible(id, actor);
    const interactions = this.db
      .prepare("SELECT * FROM crm_interactions WHERE contact = ? ORDER BY at DESC, id DESC LIMIT ?")
      .all(id, INTERACTIONS_SHOWN) as InteractionRow[];
    return { contact: toContact(r), interactions: interactions.map(toInteraction) };
  }

  /** Contacts in the same home that share an email or a link with these keys, oldest first. */
  private matches(org: string | null, keys: readonly string[], except?: number): number[] {
    if (keys.length === 0) return [];
    const marks = keys.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`SELECT DISTINCT contact FROM crm_keys WHERE org = ? AND key IN (${marks}) ORDER BY contact`)
      .all(org ?? "", ...keys) as { contact: number }[];
    return rows.map((r) => r.contact).filter((id) => id !== except);
  }

  private keysOf(fields: Pick<Fields, "emails" | "links">): string[] {
    return [...fields.emails.map(emailKey), ...fields.links.map(linkKey)];
  }

  private save(id: number, fields: Fields, org: string | null, at: string): void {
    this.db
      .prepare(
        `UPDATE crm_contacts SET org = ?, kind = ?, relation = ?, name = ?, company = ?, role = ?, links = ?, emails = ?,
           notes = ?, tags = ?, owner_only = ?, stage = ?, next_step = ?, next_due = ?, last_touch = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        org,
        fields.kind,
        fields.relation,
        fields.name,
        fields.company,
        fields.role,
        JSON.stringify(fields.links),
        JSON.stringify(fields.emails),
        fields.notes,
        JSON.stringify(fields.tags),
        fields.ownerOnly ? 1 : 0,
        fields.stage ?? null,
        fields.nextStep,
        fields.nextDue ?? null,
        fields.lastTouch ?? null,
        at,
        id,
      );
    this.db.prepare("DELETE FROM crm_keys WHERE contact = ?").run(id);
    const insert = this.db.prepare("INSERT OR IGNORE INTO crm_keys (contact, org, key) VALUES (?, ?, ?)");
    for (const key of this.keysOf(fields)) insert.run(id, org ?? "", key);
  }

  /** Folds the contact `dropId` into `keepId` inside the open transaction. */
  private fold(keepId: number, dropId: number, at: string): CrmConflict[] {
    const keep = this.row(keepId) as Row;
    const drop = this.row(dropId) as Row;
    const { fields, conflicts } = enrich(fieldsOf(toContact(keep)), fieldsOf(toContact(drop)));
    this.db.prepare("UPDATE crm_interactions SET contact = ? WHERE contact = ?").run(keepId, dropId);
    const last = this.db
      .prepare("SELECT max(at) AS at FROM crm_interactions WHERE contact = ?")
      .get(keepId) as {
      at: string | null;
    };
    this.save(keepId, { ...fields, ...(last.at === null ? {} : { lastTouch: last.at }) }, keep.org, at);
    const earliest = keep.created_at < drop.created_at ? keep.created_at : drop.created_at;
    this.db.prepare("UPDATE crm_contacts SET created_at = ? WHERE id = ?").run(earliest, keepId);
    this.db.prepare("DELETE FROM crm_contacts WHERE id = ?").run(dropId);
    return conflicts;
  }

  async upsert(input: CrmUpsertInput, actor: BusinessActor): Promise<CrmUpsertResult> {
    const org = targetOrg(actor, input.org);
    if (org !== null && !(await this.deps.orgExists(org))) {
      throw new UserError(`Workspace ${org} does not exist.`, 404);
    }
    const owner = actor.kind === "owner";
    if (input.ownerOnly && !owner) throw new UserError("Only the owner marks a contact owner-only.", 409);
    const at = this.at();
    const by = actorBy(actor);
    const existing = input.id === undefined ? undefined : this.visible(input.id, actor);
    if (existing !== undefined && !canChange(actor, existing.org)) {
      throw new UserError(`Contact ${existing.id} belongs to another scope.`, 409);
    }
    // An owner-only contact is the owner's: a tied actor's upsert never matches one.
    const incoming = inputFields(input, org, input.ownerOnly);
    const conflicts: CrmConflict[] = [];
    const merged: number[] = [];
    let id = 0;
    let result: CrmUpsertResult["result"] = "created";
    this.db.transaction(() => {
      let base = existing;
      if (base === undefined) {
        const candidates = this.matches(org, this.keysOf(incoming)).filter((cid) => {
          const r = this.row(cid);
          return r !== undefined && this.readable(actor, r);
        });
        const first = candidates[0];
        base = first === undefined ? undefined : this.row(first);
      }
      if (base === undefined) {
        const info = this.db
          .prepare(
            `INSERT INTO crm_contacts (org, kind, relation, name, by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(org, input.kind, input.relation, input.name, by, at, at);
        id = Number(info.lastInsertRowid);
        this.save(id, incoming, org, at);
      } else {
        id = base.id;
        if (existing !== undefined && owner) {
          // The owner edits: what they send replaces. Their last touch stays.
          this.save(
            id,
            { ...incoming, ...(base.last_touch === null ? {} : { lastTouch: base.last_touch }) },
            org,
            at,
          );
        } else {
          const done = enrich(fieldsOf(toContact(base)), incoming);
          conflicts.push(...done.conflicts);
          this.save(id, done.fields, base.org, at);
          result = existing === undefined ? "merged" : "updated";
        }
        if (existing !== undefined && owner) result = "updated";
      }
      // Two contacts that now share an email or link are one.
      const current = toContact(this.row(id) as Row);
      for (const other of this.matches(current.org ?? null, this.keysOf(current), id)) {
        const r = this.row(other);
        if (r === undefined || !this.readable(actor, r) || !canChange(actor, r.org)) continue;
        conflicts.push(...this.fold(id, other, at));
        merged.push(other);
      }
      if (merged.length > 0 && result === "created") result = "merged";
    })();
    this.deps.changed?.();
    return { contact: toContact(this.row(id) as Row), result, merged, conflicts };
  }

  log(
    input: {
      contact: number;
      at?: string | undefined;
      channel: CrmInteraction["channel"];
      summary: string;
      link?: string | undefined;
    },
    actor: BusinessActor,
  ): { interaction: CrmInteraction; contact: CrmContact } {
    const r = this.visible(input.contact, actor);
    if (!canChange(actor, r.org) && actor.kind !== "owner") {
      throw new UserError(`Contact ${r.id} belongs to another scope.`, 409);
    }
    const when = input.at === undefined ? this.at() : new Date(input.at).toISOString();
    const info = this.db
      .prepare(
        "INSERT INTO crm_interactions (contact, at, channel, summary, link, by) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(r.id, when, input.channel, input.summary, input.link ?? null, actorBy(actor));
    const last = this.db
      .prepare("SELECT max(at) AS at FROM crm_interactions WHERE contact = ?")
      .get(r.id) as { at: string };
    this.db
      .prepare("UPDATE crm_contacts SET last_touch = ?, updated_at = ? WHERE id = ?")
      .run(last.at, this.at(), r.id);
    this.deps.changed?.();
    const row = this.db
      .prepare("SELECT * FROM crm_interactions WHERE id = ?")
      .get(Number(info.lastInsertRowid)) as InteractionRow;
    return { interaction: toInteraction(row), contact: toContact(this.row(r.id) as Row) };
  }

  /** The owner folds one contact into another. */
  merge(
    keepId: number,
    dropId: number,
    actor: BusinessActor,
  ): { contact: CrmContact; conflicts: CrmConflict[] } {
    if (actor.kind !== "owner") throw new UserError("Only the owner merges contacts.", 409);
    if (keepId === dropId) throw new UserError("Pick two different contacts to merge.", 400);
    this.visible(keepId, actor);
    this.visible(dropId, actor);
    let conflicts: CrmConflict[] = [];
    this.db.transaction(() => {
      conflicts = this.fold(keepId, dropId, this.at());
    })();
    this.deps.changed?.();
    return { contact: toContact(this.row(keepId) as Row), conflicts };
  }

  remove(id: number, actor: BusinessActor): { id: number } {
    if (actor.kind !== "owner") throw new UserError("Only the owner deletes a contact.", 409);
    this.visible(id, actor);
    this.db.prepare("DELETE FROM crm_contacts WHERE id = ?").run(id);
    this.deps.changed?.();
    return { id };
  }

  nextSteps(
    input: {
      org?: string | undefined;
      businessOnly?: boolean | undefined;
      until?: string | undefined;
      limit: number;
    },
    actor: BusinessActor,
  ): CrmNextSteps {
    const { parts, args } = this.visibleSql(actor, input);
    const today = dayOf(this.now());
    const until = input.until ?? dayOf(new Date(this.now().getTime() + 7 * 86_400_000));
    parts.push("next_due IS NOT NULL", "next_due <= ?", "(stage IS NULL OR stage NOT IN ('won', 'lost'))");
    args.push(until);
    const rows = this.db
      .prepare(
        `SELECT * FROM crm_contacts WHERE ${parts.join(" AND ")} ORDER BY next_due, name COLLATE NOCASE, id LIMIT ?`,
      )
      .all(...args, input.limit) as Row[];
    return {
      steps: rows.map((r) => ({
        contact: toContact(r),
        due: r.next_due as string,
        overdue: (r.next_due as string) < today,
      })),
    };
  }
}
