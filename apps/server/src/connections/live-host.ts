import { hostPorts } from "@majhi/shared";

/** What the live attach reads and does. A test gives fakes. */
export interface LiveHostDeps {
  /** The connection as stored, or undefined once it is gone. `agentsOff` lists agents that must not get it. */
  connection(
    id: string,
  ): Promise<{ org: string; type: string; ports: string | undefined; agentsOff: string[] } | undefined>;
  /** The agents with a session open now. */
  sessions(): { task: string; agent: string }[];
  taskOrg(task: string): string | undefined;
  /** The scope of an agent: `root` or its org. */
  agentScope(agent: string): Promise<string | undefined>;
  /** Starts or refreshes the forwarders of a task; returns the ids it started or replaced. */
  forward(task: string, services: { id: string; ports: number[] }[]): Promise<string[]>;
  /** Stops the forwarders of one connection in every task; returns the tasks it stopped one in. */
  stop(id: string): Promise<string[]>;
  /** A line in the task's room. */
  say(task: string, text: string): void;
  /** Tells an agent with its next prompt, starting no turn. */
  tell(task: string, agent: string, text: string): void;
}

/** The name an agent reaches a service on the owner's computer by. */
const aliasOf = (id: string) => `${id}.host`;

/**
 * A service on this computer (SPEC 5.14) that becomes connected while agents work: the forwarder
 * starts at once in every task of its workspace that has a live session, the room gets a line, and
 * the agent is told with its next prompt. A session that opens later gets it from its own start, as
 * before. Idempotent: a check that passes again changes nothing, and a forwarder with the same ports
 * stays.
 */
export class LiveHostServices {
  /** One change at a time per connection, so a port change and the check after it never cross. */
  private readonly chains = new Map<string, Promise<void>>();

  constructor(private readonly deps: LiveHostDeps) {}

  /** The service's check passed. */
  connected(id: string): Promise<void> {
    return this.queue(id, () => this.start(id));
  }

  /** The service was removed, stopped being connected, or changed its ports: its forwarders end, with a line. */
  ended(id: string, why: string): Promise<void> {
    return this.queue(id, () => this.stop(id, why));
  }

  /** Its ports changed: the old forwarders end, then new ones start if it is connected. */
  changed(id: string, connected: boolean): Promise<void> {
    return this.queue(id, async () => {
      await this.stop(id, `${aliasOf(id)} changed its ports and is being set up again.`);
      if (connected) await this.start(id);
    });
  }

  private queue(id: string, run: () => Promise<void>): Promise<void> {
    const next = (this.chains.get(id) ?? Promise.resolve()).then(run, run).catch(() => undefined);
    this.chains.set(id, next);
    void next.then(() => {
      if (this.chains.get(id) === next) this.chains.delete(id);
    });
    return next;
  }

  private async start(id: string): Promise<void> {
    const found = await this.deps.connection(id);
    if (found === undefined || found.type !== "host") return;
    const ports = hostPorts(found.ports);
    if (ports.length === 0) return;
    // The agents that hold it: its own workspace's, and not the ones the owner turned it off for.
    const byTask = new Map<string, string[]>();
    for (const s of this.deps.sessions()) {
      if (this.deps.taskOrg(s.task) !== found.org || found.agentsOff.includes(s.agent)) continue;
      const scope = await this.deps.agentScope(s.agent);
      if (scope !== "root" && scope !== found.org) continue;
      byTask.set(s.task, [...(byTask.get(s.task) ?? []), s.agent]);
    }
    for (const [task, agents] of byTask) {
      let started: string[];
      try {
        started = await this.deps.forward(task, [{ id, ports }]);
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        this.deps.say(task, `${aliasOf(id)} could not start in this task: ${why}`);
        continue;
      }
      if (!started.includes(id)) continue;
      const text = `${aliasOf(id)} is now reachable from this task: ports ${ports.join(", ")}. Nothing else on this computer is.`;
      this.deps.say(task, text);
      for (const agent of agents) this.deps.tell(task, agent, text);
    }
  }

  private async stop(id: string, why: string): Promise<void> {
    for (const task of await this.deps.stop(id)) {
      this.deps.say(task, `${aliasOf(id)} is no longer reachable from this task. ${why}`);
    }
  }
}
