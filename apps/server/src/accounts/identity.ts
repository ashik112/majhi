import { createHash } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type AccountIdentity, getTool, type RuntimeOptions } from "@majhi/acp";
import type { AccountConfig } from "@majhi/shared";
import { z } from "zod";
import { errorCode, errorMessage } from "../errors.ts";
import type { AcpRuntime } from "../runtime.ts";
import { accountHome, accountRuntime } from "./homes.ts";

/**
 * Who an account is, pinned at sign-in. The sign-in file is the one file every workspace of an account shares
 * and an agent in any of them can write, so a session that swaps it for another person's would make every other
 * workspace's next session run on that other account. A session never starts on a file whose owner is not the
 * pinned one. The pin lives in majhi's own folder (`accounts/<id>/`, which no run mounts), never in a home an
 * agent writes.
 */
const PinSchema = z.object({
  identity: z.object({ id: z.string(), label: z.string() }),
  /** Hash of the sign-in file the last time its owner was read and found to be the pinned one. */
  checked: z.string(),
  /** A file whose owner was read and was not the pinned one: refused again without reading it again. */
  refused: z.object({ hash: z.string(), who: z.string() }).optional(),
});
type Pin = z.infer<typeof PinSchema>;

const PIN_FILE = ".majhi-pin.json";

/** What a check found. `unreadable` is not a mismatch: the owner could not be read, so nothing is known. */
export type SignInVerdict =
  | { state: "ok" }
  | { state: "refused"; detail: string }
  | { state: "unreadable"; detail: string };

export interface IdentityDeps {
  majhiHome: string;
  runtime: Pick<AcpRuntime, "readIdentity">;
  options: RuntimeOptions;
}

/** The pinned owner against the one just read, in the words the owner sees next to "Sign in again". */
export function refusalText(account: string, pinned: string, found: string): string {
  return `This sign-in belongs to ${found}, but ${account} was set up for ${pinned}. Sign in again as ${pinned}.`;
}

/** Pins an account's sign-in to its owner and checks the sign-in file against the pin before a session starts. */
export class SignInGuard {
  private readonly reading = new Map<string, Promise<AccountIdentity>>();

  constructor(private readonly deps: IdentityDeps) {}

  /**
   * Whether the account's sign-in file still belongs to the pinned owner. A file with the content last checked
   * passes without a read. A new content (a refresh rewrites the file) is read again in the account's own folder:
   * the same owner passes and becomes the one last checked, another owner is refused, and so is the same file on
   * the next call. An account with no pin yet is pinned to whoever is signed in. Login accounts only.
   */
  async check(id: string, config: AccountConfig): Promise<SignInVerdict> {
    if (config.auth !== "login") return { state: "ok" };
    const hash = await this.hashOf(id, config);
    // No sign-in file: the account is signed out, which its own checks already say.
    if (hash === undefined) return { state: "ok" };
    const pin = await this.readPin(id);
    if (pin?.checked === hash) return { state: "ok" };
    if (pin?.refused?.hash === hash) {
      return { state: "refused", detail: refusalText(id, pin.identity.label, pin.refused.who) };
    }
    let found: AccountIdentity;
    try {
      found = await this.read(id, config);
    } catch (err) {
      return { state: "unreadable", detail: errorMessage(err) };
    }
    if (pin === undefined) {
      await this.writePin(id, { identity: found, checked: hash });
      return { state: "ok" };
    }
    if (found.id === pin.identity.id) {
      await this.writePin(id, { identity: pin.identity, checked: hash });
      return { state: "ok" };
    }
    await this.writePin(id, { ...pin, refused: { hash, who: found.label } });
    return { state: "refused", detail: refusalText(id, pin.identity.label, found.label) };
  }

  /**
   * The owner signed in (or in again): the account now belongs to whoever is signed in. The only call that
   * moves a pin to another person. Returns who, or undefined when the owner could not be read (the pin then
   * stays, and the next check pins or refuses).
   */
  async pin(id: string, config: AccountConfig): Promise<AccountIdentity | undefined> {
    if (config.auth !== "login") return undefined;
    const hash = await this.hashOf(id, config);
    if (hash === undefined) return undefined;
    try {
      const found = await this.read(id, config);
      await this.writePin(id, { identity: found, checked: hash });
      return found;
    } catch {
      return undefined;
    }
  }

  private read(id: string, config: AccountConfig): Promise<AccountIdentity> {
    const running = this.reading.get(id);
    if (running !== undefined) return running;
    const started = this.deps.runtime
      .readIdentity(accountRuntime(this.deps.majhiHome, id, config), this.deps.options)
      .finally(() => this.reading.delete(id));
    this.reading.set(id, started);
    return started;
  }

  private async hashOf(id: string, config: AccountConfig): Promise<string | undefined> {
    const file = join(accountHome(this.deps.majhiHome, id), getTool(config.tool).signInFile);
    try {
      return createHash("sha256")
        .update(await readFile(file))
        .digest("hex");
    } catch (err) {
      if (errorCode(err) === "ENOENT") return undefined;
      throw err;
    }
  }

  private pinFile(id: string): string {
    return join(accountHome(this.deps.majhiHome, id), PIN_FILE);
  }

  private async readPin(id: string): Promise<Pin | undefined> {
    try {
      const parsed = PinSchema.safeParse(JSON.parse(await readFile(this.pinFile(id), "utf8")));
      return parsed.success ? parsed.data : undefined;
    } catch {
      // A missing or damaged pin only means the next check pins the account again.
      return undefined;
    }
  }

  private async writePin(id: string, pin: Pin): Promise<void> {
    const file = this.pinFile(id);
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(pin), { mode: 0o600 });
    await rename(temp, file);
  }
}
