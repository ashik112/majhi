import { randomBytes } from "node:crypto";
import {
  batchPick,
  type OpsActions,
  OpsActionsSchema,
  type OpsPhoneSetInput,
  type OpsPhoneSetupResult,
  type OpsPhoneStatus,
  type OwnerDecision,
  type OwnerDecisionKind,
  type PhoneAction,
} from "@majhi/shared";
import { UserError } from "../errors.ts";
import type { OpsRepo } from "./repo.ts";
import type { PhoneTokens } from "./tokens.ts";

/**
 * The phone push (SPEC 5.18, "Phone approvals"): ntfy, which needs no account. Off until the owner
 * sets it up; then a long random topic lives in secrets.age and is shown once, as a QR code.
 *
 * A push holds a title and nothing else: the workspace's name and a fixed phrase. No task title, no
 * code, no URL of a monitored service, no secret. Its buttons are single-use signed links to majhi
 * itself, which is not on the internet: they work only when the phone can reach majhi (the same
 * network, or the opt-in tunnel). Without an address the push can only wake the ntfy app.
 */

export const NTFY_DEFAULT = "https://ntfy.sh";
const PUBLISH_TIMEOUT_MS = 6_000;

const SECRET_TOPIC = "ops-ntfy-topic";
const SECRET_TOKEN = "ops-ntfy-token";
export const SECRET_KEY = "ops-phone-key";
const SETTING = "phone";

/** The fixed phrase each decision kind goes out as. */
const KIND_PHRASE: Partial<Record<OwnerDecisionKind, string>> = {
  approval: "a permission request waits for you",
  ship: "finished work waits for you to merge",
  draft: "a draft waits for your approval",
  batch: "drafts wait for your approval",
};

/** The decision kinds the phone may answer, and the switch that allows each. */
const KIND_SWITCH: Partial<Record<OwnerDecisionKind, keyof OpsActions>> = {
  approval: "approval",
  ship: "ship",
  draft: "draft",
  batch: "draft",
};

interface Stored {
  enabled: boolean;
  server: string;
  address?: string;
  actions: OpsActions;
  lastSentAt?: string;
  lastError?: string;
}

export interface SecretsPort {
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

export interface PhoneDeps {
  repo: OpsRepo;
  secrets: SecretsPort;
  tokens: PhoneTokens;
  fetch: typeof fetch;
  now: () => Date;
  orgName: (org: string | undefined) => Promise<string>;
  /** The owner's quiet hours: decision pushes wait, incidents do not. */
  inQuiet: () => Promise<boolean>;
  decisions: {
    list(): Promise<OwnerDecision[]>;
    answer(input: { id: string; option: string }): Promise<unknown>;
  };
  ack: (incident: number) => Promise<unknown>;
  changed: () => void;
}

export interface Push {
  title: string;
  message: string;
  /** ntfy priority 1 to 5. */
  priority: 3 | 4 | 5;
  tags?: string[];
  click?: string;
  actions?: Array<
    | { action: "http"; label: string; url: string; method: "POST"; clear: true }
    | { action: "view"; label: string; url: string }
  >;
}

export function serverProblem(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "That is not an address. Use https://ntfy.sh or your own ntfy server.";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "Use an http or https address.";
  if (url.username !== "" || url.password !== "") return "Leave the sign-in out of the address.";
  return undefined;
}

export function addressProblem(raw: string): string | undefined {
  return serverProblem(raw)?.replace(
    "Use https://ntfy.sh or your own ntfy server.",
    "Use an address like http://192.168.1.20:7070.",
  );
}

function origin(raw: string): string {
  return new URL(raw).origin;
}

/** What the QR code holds: the ntfy app opens `ntfy://` links and subscribes. */
export function subscribeLink(server: string, topic: string): string {
  const url = new URL(server);
  return `ntfy://${url.host}/${topic}${url.protocol === "http:" ? "?secure=false" : ""}`;
}

export class PhoneChannel {
  constructor(private readonly deps: PhoneDeps) {}

  private load(): Stored | undefined {
    const raw = this.deps.repo.setting(SETTING);
    if (raw === undefined) return undefined;
    try {
      const parsed = JSON.parse(raw) as Partial<Stored>;
      return {
        enabled: parsed.enabled === true,
        server: typeof parsed.server === "string" ? parsed.server : NTFY_DEFAULT,
        ...(typeof parsed.address === "string" ? { address: parsed.address } : {}),
        actions: OpsActionsSchema.parse(parsed.actions ?? {}),
        ...(typeof parsed.lastSentAt === "string" ? { lastSentAt: parsed.lastSentAt } : {}),
        ...(typeof parsed.lastError === "string" ? { lastError: parsed.lastError } : {}),
      };
    } catch {
      return undefined;
    }
  }

  private save(s: Stored): void {
    this.deps.repo.setSetting(SETTING, JSON.stringify(s));
  }

  async status(): Promise<OpsPhoneStatus> {
    const s = this.load();
    const hasTopic = s !== undefined && (await this.deps.secrets.get(SECRET_TOPIC)) !== undefined;
    if (s === undefined || !hasTopic) {
      return { state: "off", hasTopic: false, actions: OpsActionsSchema.parse({}), buttons: false };
    }
    const anyAction = s.actions.approval || s.actions.ship || s.actions.draft;
    return {
      state: s.enabled ? "on" : "paused",
      server: s.server,
      hasTopic: true,
      ...(s.address === undefined ? {} : { address: s.address }),
      actions: s.actions,
      buttons: s.address !== undefined && anyAction,
      ...(s.lastSentAt === undefined ? {} : { lastSentAt: s.lastSentAt }),
      ...(s.lastError === undefined ? {} : { lastError: s.lastError }),
    };
  }

  /** Makes the topic and the signing key. The topic goes back once, to the screen that shows the QR. */
  async setup(input: {
    server?: string | undefined;
    token?: string | undefined;
  }): Promise<OpsPhoneSetupResult> {
    const given = input.server ?? NTFY_DEFAULT;
    const problem = serverProblem(given);
    if (problem !== undefined) throw new UserError(problem, 400);
    const server = origin(given);
    const topic = `majhi-${randomBytes(18).toString("base64url")}`;
    await this.deps.secrets.set(SECRET_TOPIC, topic);
    await this.deps.secrets.set(SECRET_KEY, randomBytes(32).toString("base64"));
    if (input.token !== undefined) await this.deps.secrets.set(SECRET_TOKEN, input.token);
    else await this.deps.secrets.delete(SECRET_TOKEN);
    const before = this.load();
    this.deps.repo.clearTokens();
    this.save({
      enabled: true,
      server,
      ...(before?.address === undefined ? {} : { address: before.address }),
      actions: before?.actions ?? OpsActionsSchema.parse({}),
    });
    this.deps.changed();
    return { server, topic, link: subscribeLink(server, topic), status: await this.status() };
  }

  async set(input: OpsPhoneSetInput): Promise<OpsPhoneStatus> {
    const s = this.load();
    if (s === undefined || (await this.deps.secrets.get(SECRET_TOPIC)) === undefined) {
      throw new UserError("Set up the phone first.", 409);
    }
    let address = s.address;
    if (input.address === null || input.address === "") address = undefined;
    else if (input.address !== undefined) {
      const problem = addressProblem(input.address);
      if (problem !== undefined) throw new UserError(problem, 400);
      address = origin(input.address);
    }
    const { address: _old, ...rest } = s;
    this.save({
      ...rest,
      enabled: input.enabled ?? s.enabled,
      ...(address === undefined ? {} : { address }),
      actions: {
        approval: input.actions?.approval ?? s.actions.approval,
        ship: input.actions?.ship ?? s.actions.ship,
        draft: input.actions?.draft ?? s.actions.draft,
      },
    });
    // An address that goes away takes the buttons' links with it.
    if (address === undefined) this.deps.repo.clearTokens();
    this.deps.changed();
    return this.status();
  }

  /** An acknowledged incident's remaining buttons stop working. */
  voidFor(decision: string): void {
    this.deps.tokens.void(decision);
  }

  async forget(): Promise<OpsPhoneStatus> {
    await this.deps.secrets.delete(SECRET_TOPIC);
    await this.deps.secrets.delete(SECRET_KEY);
    await this.deps.secrets.delete(SECRET_TOKEN);
    this.deps.repo.deleteSetting(SETTING);
    this.deps.repo.clearTokens();
    this.deps.changed();
    return this.status();
  }

  /** Sends one push. Never throws and never logs the topic: a failure is a short sentence on the status. */
  async publish(push: Push, force = false): Promise<{ sent: boolean; error?: string }> {
    const s = this.load();
    if (s === undefined || (!s.enabled && !force)) return { sent: false, error: "The phone push is off." };
    const topic = await this.deps.secrets.get(SECRET_TOPIC);
    if (topic === undefined) return { sent: false, error: "The phone push is not set up." };
    const token = await this.deps.secrets.get(SECRET_TOKEN);
    let error: string | undefined;
    try {
      const res = await this.deps.fetch(s.server, {
        method: "POST",
        signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
        headers: {
          "content-type": "application/json",
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify({ topic, ...push }),
      });
      void res.body?.cancel().catch(() => undefined);
      if (!res.ok) error = `The ntfy server answered ${res.status}.`;
    } catch {
      error = "Could not reach the ntfy server.";
    }
    const now = this.deps.now().toISOString();
    const { lastError: _e, lastSentAt: _l, ...rest } = s;
    this.save({
      ...rest,
      ...(error === undefined
        ? { lastSentAt: now }
        : s.lastSentAt === undefined
          ? {}
          : { lastSentAt: s.lastSentAt }),
      ...(error === undefined ? {} : { lastError: error }),
    });
    this.deps.changed();
    return error === undefined ? { sent: true } : { sent: false, error };
  }

  async test(): Promise<{ sent: boolean; error?: string }> {
    return this.publish(
      { title: "majhi", message: "This is a test. majhi can reach this phone.", priority: 3, tags: ["bell"] },
      true,
    );
  }

  /** A button's link: an opaque reference and the signed token. It names no decision and no task. */
  private link(address: string, minted: { ref: string; token: string }, action: PhoneAction): string {
    return `${address}/ops/phone/${minted.ref}/${action}?t=${minted.token}`;
  }

  /** The push for an incident. `repeat` is the second, louder one. */
  async pushIncident(
    incident: { id: number; org: string; severity: "high" | "medium" | "low" },
    repeat: boolean,
  ): Promise<{ sent: boolean; error?: string }> {
    const s = this.load();
    if (s === undefined || !s.enabled) return { sent: false, error: "The phone push is off." };
    const ws = await this.deps.orgName(incident.org);
    const decision = `incident:${incident.id}`;
    const push: Push = {
      title: repeat ? `${ws}: incident still not acknowledged` : `${ws}: incident, ${incident.severity}`,
      message: "A service needs you. Open majhi for the details.",
      priority: repeat ? 5 : 4,
      tags: ["rotating_light"],
    };
    if (s.address !== undefined) {
      push.click = `${s.address}/watch`;
      const token = await this.deps.tokens.mint(decision, "ack");
      push.actions = [{ action: "view", label: "Open", url: `${s.address}/watch` }];
      if (token !== undefined) {
        push.actions.unshift({
          action: "http",
          label: "Acknowledge",
          url: this.link(s.address, token, "ack"),
          method: "POST",
          clear: true,
        });
      }
    }
    return this.publish(push);
  }

  /** Whether a decision kind may be pushed and answered from the phone now. */
  private allowed(kind: OwnerDecisionKind, s: Stored): boolean {
    const sw = KIND_SWITCH[kind];
    return sw !== undefined && s.actions[sw];
  }

  /** Pushes the decisions the owner enabled, once each. A failed push is tried again next sweep. */
  async sweepDecisions(): Promise<number> {
    const s = this.load();
    if (s === undefined || !s.enabled) return 0;
    const now = this.deps.now();
    this.deps.repo.prunePushed(new Date(now.getTime() - 14 * 86_400_000).toISOString());
    this.deps.repo.pruneTokens(new Date(now.getTime() - 86_400_000).toISOString());
    if (await this.deps.inQuiet()) return 0;
    let sent = 0;
    for (const d of await this.deps.decisions.list()) {
      if (!this.allowed(d.kind, s) || this.deps.repo.pushed(d.id)) continue;
      const phrase = KIND_PHRASE[d.kind];
      if (phrase === undefined) continue;
      const ws = await this.deps.orgName(d.org);
      const push: Push = { title: `${ws}: ${phrase}`, message: "Open majhi to answer.", priority: 3 };
      if (s.address !== undefined) {
        push.click = `${s.address}/decisions`;
        push.actions = [{ action: "view", label: "Open", url: `${s.address}/decisions` }];
        const approve = await this.deps.tokens.mint(d.id, "approve");
        const leave = await this.deps.tokens.mint(d.id, "leave");
        if (approve !== undefined && leave !== undefined) {
          push.actions.unshift(
            {
              action: "http",
              label: "Approve",
              url: this.link(s.address, approve, "approve"),
              method: "POST",
              clear: true,
            },
            {
              action: "http",
              label: "Leave",
              url: this.link(s.address, leave, "leave"),
              method: "POST",
              clear: true,
            },
          );
        }
      }
      const res = await this.publish(push);
      if (!res.sent) break;
      this.deps.repo.markPushed(d.id, now.toISOString());
      sent += 1;
    }
    return sent;
  }

  /**
   * A button was pressed: spend the token, then do what the owner would have done in Decisions. Every
   * refusal is the same sentence.
   */
  async act(ref: string, action: string, token: string): Promise<{ ok: boolean; text: string }> {
    const refused = { ok: false, text: "This link does not work. Open majhi to answer." };
    const s = this.load();
    if (s === undefined || !s.enabled) return refused;
    const verdict = await this.deps.tokens.redeem(token, ref, action);
    if (!verdict.ok) return refused;
    const decision = verdict.decision;
    if (verdict.action === "ack") {
      const parsed = /^incident:([1-9]\d*)$/.exec(decision);
      if (parsed === null) return refused;
      try {
        await this.deps.ack(Number(parsed[1]));
      } catch {
        return refused;
      }
      this.deps.tokens.void(decision);
      return { ok: true, text: "Acknowledged." };
    }
    const found = (await this.deps.decisions.list()).find((d) => d.id === decision);
    if (found === undefined || !this.allowed(found.kind, s)) return refused;
    const pick = batchPick(found, verdict.action === "approve" ? "approve" : "leave");
    if ("reason" in pick) return { ok: false, text: `Not done: ${pick.reason}. Open majhi to answer.` };
    try {
      await this.deps.decisions.answer({ id: found.id, option: pick.option.id });
    } catch {
      return { ok: false, text: "That did not work. Open majhi to answer." };
    }
    this.deps.tokens.void(decision);
    return { ok: true, text: verdict.action === "approve" ? "Approved." : "Declined." };
  }
}
