import { addDays, dayStart, localDay, weekStart } from "../usage/ranges.ts";
import { quietWeek, reportFacts, reportTexts } from "./report.ts";
import type { ReportRepo } from "./report-repo.ts";
import { briefDue, ownerZone } from "./time.ts";

export interface ReportDeps {
  repo: ReportRepo;
  /** The brief hour (`HH:MM`) and the owner's zone: the report is made on Monday at that hour. */
  clock: () => Promise<{ at: string; tz?: string | undefined }>;
  /** Every workspace but Private. */
  orgs: () => Promise<{ id: string; name: string; tz?: string | undefined }[]>;
  /** The workspace's Client update switch. Ask me holds the report for the owner; Captain sends lets it out. */
  clientUpdate: (org: string) => Promise<"ask" | "sends">;
  /** The workspace's "Show cost to client" switch. */
  showCost: (org: string) => Promise<boolean>;
  /** The workspace's linked chats, each with its "Gets weekly report" switch. */
  rooms: (org: string) => { room: string; weekly: boolean }[];
  /** Hands the client copy to one chat. Ask me holds it as a draft; sends goes through the fixed rails. */
  send: (room: string, org: string, text: string, mode: "ask" | "sends") => Promise<void>;
  /** Puts the internal copy in the workspace's own captain conversation. */
  internal: (org: string, week: string, text: string) => Promise<void>;
  now?: (() => Date) | undefined;
}

/**
 * The weekly client report. On Monday at the brief hour, for each workspace that has a linked client chat, the previous
 * Monday to Sunday is turned into facts and two copies of the words, once (`weekly_reports` holds the week). A quiet week
 * makes nothing. The internal copy goes to the workspace's captain conversation; the client copy goes only to the chats
 * whose "Gets weekly report" switch is on, and only the Client update switch decides whether it is held for the owner.
 * No model is asked: the words are a template over the facts.
 */
export class ReportService {
  constructor(private readonly deps: ReportDeps) {}

  /** Makes the reports that are due. Never throws: the next minute tries again. */
  async sweep(): Promise<void> {
    try {
      const clock = await this.deps.clock();
      for (const org of await this.deps.orgs()) {
        if (this.deps.rooms(org.id).length === 0) continue;
        await this.makeFor(org, clock).catch((err: unknown) =>
          console.error("majhi: the weekly report failed:", err instanceof Error ? err.message : String(err)),
        );
      }
    } catch (err) {
      // The next minute tries again.
      console.error("majhi: the weekly report failed:", err instanceof Error ? err.message : String(err));
    }
  }

  private async makeFor(
    org: { id: string; name: string; tz?: string | undefined },
    clock: { at: string; tz?: string | undefined },
  ): Promise<void> {
    const tz = ownerZone(org.tz ?? clock.tz);
    const now = this.deps.now?.() ?? new Date();
    // This week's Monday at the brief hour: from then on the week before it is due, until the next Monday.
    const monday = weekStart(localDay(now, tz));
    if (now.getTime() < briefDue(monday, clock.at, tz).getTime()) return;
    const week = addDays(monday, -7);
    if (!this.deps.repo.claim(week, org.id, now.toISOString())) return;
    const from = dayStart(week, tz).toISOString();
    const to = dayStart(monday, tz).toISOString();
    const facts = reportFacts({
      org: org.id,
      orgName: org.name,
      week,
      from,
      to,
      rows: this.deps.repo.rows(org.id, from, to),
    });
    if (quietWeek(facts)) return;
    const text = reportTexts(facts, await this.deps.showCost(org.id));
    await this.deps.internal(org.id, week, text.internal);
    const mode = await this.deps.clientUpdate(org.id);
    for (const room of this.deps.rooms(org.id)) {
      if (!room.weekly) continue;
      await this.deps.send(room.room, org.id, text.client, mode).catch(() => undefined);
    }
  }
}
