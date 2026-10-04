import {
  type VoiceFields,
  type VoiceGet,
  type VoiceProfile,
  VoiceProfileSchema,
  type VoiceProposal,
  VoiceProposalSchema,
} from "@majhi/shared";
import type Database from "better-sqlite3";
import { UserError } from "../errors.ts";
import { actorBy, type BusinessActor, tiedOrg } from "./scope.ts";

/**
 * Voice profiles (SPEC 5.19): how the owner writes, for the business and optionally per workspace. The
 * owner writes or edits one. The captain builds a proposal from the owner's samples and the owner
 * accepts it; a proposal never replaces the profile by itself.
 */

/** The row key of the business-wide profile. */
const BUSINESS = "";

interface Row {
  scope: string;
  profile: string;
  proposal: string | null;
}

export interface VoiceDeps {
  db: Database.Database;
  now?: () => Date;
  orgExists: (org: string) => Promise<boolean>;
  changed?: () => void;
}

function parse<T>(
  raw: string | null,
  schema: { safeParse(v: unknown): { success: boolean; data?: T } },
): T | undefined {
  if (raw === null) return undefined;
  try {
    const parsed = schema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export class VoiceService {
  private readonly db: Database.Database;

  constructor(private readonly deps: VoiceDeps) {
    this.db = deps.db;
  }

  private at(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  private row(scope: string): Row | undefined {
    return this.db.prepare("SELECT * FROM voice_profiles WHERE scope = ?").get(scope) as Row | undefined;
  }

  /** The scope an actor works in: a tied actor in its workspace only; others the one they name. */
  private scopeOf(actor: BusinessActor, asked: string | undefined): string {
    const own = tiedOrg(actor);
    if (own !== undefined && asked !== undefined && asked !== own) {
      throw new UserError("That belongs to another workspace.", 409);
    }
    return own ?? asked ?? BUSINESS;
  }

  /** The profile of a scope and what a draft there would use: its own, else the business one. */
  get(asked: string | undefined, actor: BusinessActor): VoiceGet {
    const scope = this.scopeOf(actor, asked);
    const row = this.row(scope);
    const own = parse<VoiceProfile>(row?.profile ?? null, VoiceProfileSchema);
    const proposal = parse<VoiceProposal>(row?.proposal ?? null, VoiceProposalSchema);
    const fallback =
      scope === BUSINESS
        ? undefined
        : parse<VoiceProfile>(this.row(BUSINESS)?.profile ?? null, VoiceProfileSchema);
    const effective = own ?? fallback;
    return {
      ...(own === undefined ? {} : { own }),
      ...(effective === undefined ? {} : { effective }),
      inherited: own === undefined && fallback !== undefined,
      ...(proposal === undefined ? {} : { proposal }),
    };
  }

  private async checkOrg(scope: string): Promise<void> {
    if (scope !== BUSINESS && !(await this.deps.orgExists(scope))) {
      throw new UserError(`Workspace ${scope} does not exist.`, 404);
    }
  }

  private write(scope: string, profile: VoiceProfile | undefined, proposal: VoiceProposal | undefined): void {
    this.db
      .prepare(
        `INSERT INTO voice_profiles (scope, profile, proposal) VALUES (?, ?, ?)
         ON CONFLICT (scope) DO UPDATE SET profile = excluded.profile, proposal = excluded.proposal`,
      )
      .run(scope, JSON.stringify(profile ?? {}), proposal === undefined ? null : JSON.stringify(proposal));
    this.deps.changed?.();
  }

  private current(scope: string): { profile: VoiceProfile | undefined; proposal: VoiceProposal | undefined } {
    const row = this.row(scope);
    return {
      profile: parse<VoiceProfile>(row?.profile ?? null, VoiceProfileSchema),
      proposal: parse<VoiceProposal>(row?.proposal ?? null, VoiceProposalSchema),
    };
  }

  /** The owner writes or edits a profile. */
  async set(input: VoiceFields & { org?: string | undefined }, actor: BusinessActor): Promise<VoiceGet> {
    if (actor.kind !== "owner")
      throw new UserError("Only the owner sets the voice. Propose one instead.", 409);
    const scope = input.org ?? BUSINESS;
    await this.checkOrg(scope);
    const { profile: _old, proposal } = this.current(scope);
    const { org: _org, ...fields } = input;
    this.write(
      scope,
      VoiceProfileSchema.parse({
        ...fields,
        ...(scope === BUSINESS ? {} : { org: scope }),
        by: "owner",
        updatedAt: this.at(),
      }),
      proposal,
    );
    return this.get(scope === BUSINESS ? undefined : scope, actor);
  }

  /** The captain or an agent proposes a profile built from the owner's samples. It waits for the owner. */
  async propose(
    input: VoiceFields & { org?: string | undefined; why: string },
    actor: BusinessActor,
  ): Promise<VoiceGet> {
    const own = tiedOrg(actor);
    // A tied actor proposes for its own workspace; the business voice is proposed by the owner's captain only.
    const scope = this.scopeOf(actor, input.org);
    if (own !== undefined && scope === BUSINESS)
      throw new UserError("That belongs to the whole business.", 409);
    await this.checkOrg(scope);
    const { profile } = this.current(scope);
    const { org: _org, ...fields } = input;
    const proposal = VoiceProposalSchema.parse({
      ...fields,
      ...(scope === BUSINESS ? {} : { org: scope }),
      by: actorBy(actor),
      at: this.at(),
    });
    this.write(scope, profile, proposal);
    return this.get(scope === BUSINESS ? undefined : scope, actor);
  }

  /** The owner accepts the proposal (it becomes the profile) or drops it. */
  async decide(
    input: { org?: string | undefined; accept: boolean },
    actor: BusinessActor,
  ): Promise<VoiceGet> {
    if (actor.kind !== "owner") throw new UserError("Only the owner decides on a proposed voice.", 409);
    const scope = input.org ?? BUSINESS;
    const { profile, proposal } = this.current(scope);
    if (proposal === undefined) throw new UserError("No voice is proposed here.", 404);
    if (input.accept) {
      const { why: _why, at: _at, by: _by, ...fields } = proposal;
      // Samples are the owner's text: the proposal keeps the ones already there.
      const samples = profile?.samples ?? fields.samples;
      this.write(
        scope,
        VoiceProfileSchema.parse({ ...fields, samples, by: "owner", updatedAt: this.at() }),
        undefined,
      );
    } else {
      this.write(scope, profile, undefined);
    }
    return this.get(scope === BUSINESS ? undefined : scope, actor);
  }
}
