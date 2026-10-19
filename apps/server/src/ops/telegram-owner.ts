import type { ChatEnvelope, OpsTelegramStatus } from "@majhi/shared";
import { UserError } from "../errors.ts";
import type { OpsRepo } from "./repo.ts";

/**
 * The owner's Telegram channel for incident pings. It is the same single ping as the phone push (`pingFor` decides,
 * this only delivers). It uses one of the workspace's Telegram bots and the owner's private chat with it.
 *
 * Pairing is done in Settings and nothing else: the owner picks a bot, majhi shows the exact message to send it
 * (`/start` and a one-time code), and the owner's private chat is learned from that one message. Anyone else who
 * writes to the bot is never paired: without the code the message is an ordinary one. The code works for 15 minutes.
 * A ping holds the workspace's name and a fixed phrase and nothing else (no title, no service address, no secret).
 */

const SETTING = "telegram";
const PAIR_MS = 15 * 60_000;

interface Stored {
  connection: string;
  account: string;
  /** The owner's private chat, once paired. */
  chat?: string;
  /** While pairing: the code to send and when it stops working. */
  code?: string;
  expiresAt?: string;
  lastSentAt?: string;
  lastError?: string;
}

export interface OwnerTelegramDeps {
  repo: Pick<OpsRepo, "setting" | "setSetting" | "deleteSetting">;
  /** The Telegram bot connections that exist. */
  bots: () => Promise<{ connection: string; account: string }[]>;
  /** Sends plain text to a chat of a Telegram bot. Throws when Telegram refuses. */
  send: (account: string, chat: string, text: string) => Promise<void>;
  orgName: (org: string) => Promise<string>;
  /** A fresh pairing code. */
  newCode: () => string;
  now: () => Date;
  changed: () => void;
}

function parse(raw: string | undefined): Stored | undefined {
  if (raw === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return undefined;
    const v = value as Record<string, unknown>;
    if (typeof v.connection !== "string" || typeof v.account !== "string") return undefined;
    return {
      connection: v.connection,
      account: v.account,
      ...(typeof v.chat === "string" ? { chat: v.chat } : {}),
      ...(typeof v.code === "string" ? { code: v.code } : {}),
      ...(typeof v.expiresAt === "string" ? { expiresAt: v.expiresAt } : {}),
      ...(typeof v.lastSentAt === "string" ? { lastSentAt: v.lastSentAt } : {}),
      ...(typeof v.lastError === "string" ? { lastError: v.lastError } : {}),
    };
  } catch {
    return undefined;
  }
}

export class OwnerTelegram {
  constructor(private readonly deps: OwnerTelegramDeps) {}

  private load(): Stored | undefined {
    return parse(this.deps.repo.setting(SETTING));
  }

  private save(s: Stored): void {
    this.deps.repo.setSetting(SETTING, JSON.stringify(s));
  }

  async status(): Promise<OpsTelegramStatus> {
    const bots = await this.deps.bots();
    const s = this.load();
    if (s === undefined) return { state: "off", bots };
    const base = { bots, connection: s.connection, account: s.account };
    if (s.chat !== undefined) {
      return {
        state: "on",
        ...base,
        ...(s.lastSentAt === undefined ? {} : { lastSentAt: s.lastSentAt }),
        ...(s.lastError === undefined ? {} : { lastError: s.lastError }),
      };
    }
    const live = s.expiresAt !== undefined && Date.parse(s.expiresAt) > this.deps.now().getTime();
    if (!live) return { state: "off", bots };
    return { state: "waiting", ...base, step: `Send  /start ${s.code}  to ${s.account} on Telegram.` };
  }

  /** Starts pairing with a bot. Returns the exact message to send. */
  async setup(connection: string): Promise<OpsTelegramStatus> {
    const bot = (await this.deps.bots()).find((b) => b.connection === connection);
    if (bot === undefined) throw new UserError("That Telegram bot is not connected.", 404);
    this.save({
      connection: bot.connection,
      account: bot.account,
      code: this.deps.newCode(),
      expiresAt: new Date(this.deps.now().getTime() + PAIR_MS).toISOString(),
    });
    this.deps.changed();
    return this.status();
  }

  async forget(): Promise<OpsTelegramStatus> {
    this.deps.repo.deleteSetting(SETTING);
    this.deps.changed();
    return this.status();
  }

  /**
   * Offered every message a Telegram bot reads, before it is stored as a client's. True when it belongs to the owner's
   * channel and must not become a client chat: the pairing message, and anything the paired chat writes.
   */
  async claims(connection: string, envelope: ChatEnvelope): Promise<boolean> {
    const s = this.load();
    if (s === undefined || s.connection !== connection || envelope.chat.kind !== "private") return false;
    if (s.chat !== undefined) return envelope.external.chat === s.chat;
    if (s.code === undefined || s.expiresAt === undefined) return false;
    if (Date.parse(s.expiresAt) <= this.deps.now().getTime()) return false;
    const [command, code, ...rest] = envelope.text
      .trim()
      .split(" ")
      .filter((w) => w !== "");
    if (command !== "/start" || code !== s.code || rest.length > 0) return false;
    const { code: _code, expiresAt: _expires, ...paired } = s;
    this.save({ ...paired, chat: envelope.external.chat });
    this.deps.changed();
    await this.deps
      .send(s.account, envelope.external.chat, "majhi will ping you here when an incident needs you.")
      .catch(() => undefined);
    return true;
  }

  /** One ping to the paired chat. Never throws; a failure is a short sentence on the status. */
  async ping(input: {
    org: string;
    severity: string;
    repeat: boolean;
  }): Promise<{ sent: boolean; error?: string }> {
    const s = this.load();
    if (s?.chat === undefined) return { sent: false, error: "Telegram is not set up." };
    const ws = await this.deps.orgName(input.org);
    const text = input.repeat
      ? `${ws}: incident still not acknowledged. Open majhi.`
      : `${ws}: incident, ${input.severity}. Open majhi.`;
    return this.deliver(s, s.chat, text);
  }

  async test(): Promise<{ sent: boolean; error?: string }> {
    const s = this.load();
    if (s?.chat === undefined) return { sent: false, error: "Telegram is not set up." };
    return this.deliver(s, s.chat, "majhi: this is a test ping.");
  }

  private async deliver(s: Stored, chat: string, text: string): Promise<{ sent: boolean; error?: string }> {
    try {
      await this.deps.send(s.account, chat, text);
      const { lastError: _e, ...rest } = s;
      this.save({ ...rest, lastSentAt: this.deps.now().toISOString() });
      return { sent: true };
    } catch {
      const error = "Telegram did not take the message.";
      this.save({ ...s, lastError: error });
      return { sent: false, error };
    }
  }
}
