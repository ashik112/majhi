/**
 * The phone channels of an incident ping. `pingFor` (packages/shared/src/incident.ts) decides whether a ping goes
 * out; this only delivers the one ping to every channel that is set up and remembers which channel has it, so a retry
 * after one channel was down never sends the other a second copy.
 */

export interface IncidentPush {
  name: string;
  push(
    incident: { id: number; org: string; severity: "high" | "medium" | "low" },
    repeat: boolean,
  ): Promise<{ sent: boolean; error?: string }>;
}

const REMEMBER = 200;

export class IncidentPings {
  /** `incident:repeat` to the channels that already have it. */
  private readonly delivered = new Map<string, Set<string>>();

  constructor(private readonly channels: readonly IncidentPush[]) {}

  /** Sends to each channel that does not have this ping yet. True when at least one channel has it now. */
  async send(
    incident: { id: number; org: string; severity: "high" | "medium" | "low" },
    repeat: boolean,
  ): Promise<{ sent: boolean }> {
    const key = `${incident.id}:${repeat ? "repeat" : "first"}`;
    const have = this.delivered.get(key) ?? new Set<string>();
    for (const channel of this.channels) {
      if (have.has(channel.name)) continue;
      const out = await channel.push(incident, repeat).catch(() => ({ sent: false }));
      if (out.sent) have.add(channel.name);
    }
    if (have.size > 0) {
      this.delivered.set(key, have);
      if (this.delivered.size > REMEMBER) {
        const oldest = this.delivered.keys().next().value;
        if (oldest !== undefined) this.delivered.delete(oldest);
      }
    }
    return { sent: have.size > 0 };
  }
}
