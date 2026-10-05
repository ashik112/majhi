import { type CaptainChore, type Playbook, PlaybookSchema } from "@majhi/shared";
import { OPS_PLAYBOOKS } from "./builtin/ops.ts";
import { UPKEEP_PLAYBOOKS } from "./builtin/upkeep.ts";

/**
 * The playbooks that ship with majhi, as data (`./builtin`). They are read once and checked against the
 * schema; a malformed one stops the server at start, not at the first run. User-defined playbooks come
 * later and will join this list.
 */

export class Catalog {
  private readonly byId = new Map<string, Playbook>();

  constructor(playbooks: readonly Playbook[] = BUILTIN) {
    for (const raw of playbooks) {
      const pb = PlaybookSchema.parse(raw);
      if (this.byId.has(pb.id)) throw new Error(`Two playbooks use the id "${pb.id}".`);
      this.byId.set(pb.id, pb);
    }
  }

  /** Adds a playbook (a user-defined one, later; tests now). Its id must be new. */
  register(raw: Playbook): Playbook {
    const pb = PlaybookSchema.parse(raw);
    if (this.byId.has(pb.id)) throw new Error(`Two playbooks use the id "${pb.id}".`);
    this.byId.set(pb.id, pb);
    return pb;
  }

  /** Adds a playbook or replaces the one with its id (a clock playbook the owner edited). */
  put(raw: Playbook): Playbook {
    const pb = PlaybookSchema.parse(raw);
    this.byId.set(pb.id, pb);
    return pb;
  }

  /** Removes a playbook the owner made. Shipped ones stay. */
  unregister(id: string): boolean {
    return this.byId.get(id)?.custom === true && this.byId.delete(id);
  }

  all(): Playbook[] {
    return [...this.byId.values()];
  }

  get(id: string): Playbook | undefined {
    return this.byId.get(id);
  }

  /** The playbook that carries out a chore. */
  ofChore(chore: CaptainChore): Playbook | undefined {
    return this.all().find((p) => p.runner.kind === "chore" && p.runner.chore === chore);
  }
}

export const BUILTIN: readonly Playbook[] = [...UPKEEP_PLAYBOOKS, ...OPS_PLAYBOOKS];
