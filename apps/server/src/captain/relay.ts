import { PRIVATE } from "@majhi/shared";
import type { ConfigService } from "../config/service.ts";
import type { RoomPayload } from "../store/index.ts";
import type { Lanes } from "./lanes.ts";

export interface RelayDeps {
  config: ConfigService;
  lanes: Lanes;
  /** The owner's current captain chat and the captain's agent id, or undefined when there is none yet. */
  bossChat: () => Promise<{ chat: string; agent: string } | undefined>;
  post: (task: string, id: string, payload: RoomPayload) => void;
  now: () => Date;
}

/**
 * A workspace captain finished a turn: its message to the owner shows in the root chat as it lands,
 * one short line with the workspace and the thread to read the rest in, so the owner never has to
 * watch every thread.
 */
export class RootRelay {
  constructor(private readonly deps: RelayDeps) {}

  async relay(lane: string, text: string): Promise<void> {
    const org = this.deps.lanes.orgOf(lane);
    if (org === undefined) return;
    const boss = await this.deps.bossChat();
    if (boss === undefined || boss.chat === lane) return;
    const line = relayLine(text);
    if (line === "") return;
    const sections = await this.deps.config.sections();
    const name = org === PRIVATE ? "Private" : (sections.orgs[org]?.name ?? org);
    const at = this.deps.now().getTime();
    this.deps.post(boss.chat, `relay:${lane}:${at}`, {
      type: "agent",
      agent: boss.agent,
      text: `**${name}** (${lane}): ${line}`,
    });
  }
}

/** The first paragraph of a lane message, without markdown headings, at most about 320 characters. */
export function relayLine(text: string): string {
  const first =
    text
      .split(/\n\s*\n/)
      .map((p) => p.replace(/^#+\s*/gm, "").trim())
      .find((p) => p !== "") ?? "";
  const flat = first.replace(/\s*\n\s*/g, " ");
  if (flat.length <= 320) return flat;
  const cut = flat.slice(0, 320);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf(" "));
  return `${cut.slice(0, end > 200 ? end + 1 : 320).trim()} …`;
}
