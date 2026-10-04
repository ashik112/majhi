import { createHash } from "node:crypto";
import { ConnectAccessSchema, ConnectStateSchema, IdSchema } from "@majhi/shared";
import { z } from "zod";
import type { SecretStore } from "../secrets/store.ts";

/**
 * What majhi keeps for one connected service of one workspace (SPEC 5.14). It lives in secrets.age
 * as one JSON secret per connection, so the tokens are encrypted with the rest, backed up with the
 * key, and removed together. Nothing here is ever logged or returned over HTTP.
 */

export const GrantSchema = z.object({
  v: z.literal(1),
  connection: IdSchema,
  org: IdSchema,
  /** The catalog entry, when there is one. */
  service: IdSchema.optional(),
  /** The MCP server's address, which is also the `resource` of the tokens. */
  serverUrl: z.string(),
  resource: z.string(),
  /** The authorization server the tokens came from, and the only one they go back to. */
  issuer: z.string(),
  authorizationServerUrl: z.string(),
  revocationEndpoint: z.string().optional(),
  /** The client majhi registered itself as at this issuer. */
  clientId: z.string(),
  state: ConnectStateSchema,
  /** Why it is not `connected`, in a sentence that does not hold a token or the service's own text. */
  stateReason: z.string().default(""),
  tokens: z.object({
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1).optional(),
    /** ISO time the access token ends, when the service said. */
    expiresAt: z.string().optional(),
    scope: z.array(z.string()),
  }),
  /** The scope names the last step asked for and the grant lacks. */
  missing: z.array(z.string()).default([]),
  /** The scopes the grant was asked for, to ask for the union when more is needed. */
  requested: z.array(z.string()).default([]),
  /** What the owner chose on the consent step. */
  access: ConnectAccessSchema.default("read"),
  account: z.object({ id: z.string().optional(), label: z.string().optional() }),
  connectedAt: z.string(),
  updatedAt: z.string(),
});
export type Grant = z.infer<typeof GrantSchema>;

/** A client registration at one issuer for one redirect address. The client is majhi, not the account. */
export const RegistrationSchema = z.object({
  v: z.literal(1),
  issuer: z.string(),
  redirect: z.string(),
  clientId: z.string().min(1),
  clientSecret: z.string().optional(),
  via: z.enum(["dcr", "cimd"]),
});
export type Registration = z.infer<typeof RegistrationSchema>;

export const grantName = (connection: string) => `oauth-${connection}`;

function registrationName(issuer: string, redirect: string): string {
  return `oauthreg-${createHash("sha256").update(`${issuer}\n${redirect}`).digest("hex").slice(0, 16)}`;
}

/** Reads and writes grants and registrations. A value that does not parse counts as absent. */
export class GrantStore {
  /** One write at a time per connection, so a refresh and a state change never interleave. */
  private readonly chain = new Map<string, Promise<unknown>>();

  constructor(private readonly secrets: Pick<SecretStore, "get" | "set" | "delete" | "names">) {}

  async get(connection: string): Promise<Grant | undefined> {
    const raw = await this.secrets.get(grantName(connection));
    if (raw === undefined) return undefined;
    try {
      const parsed = GrantSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  async save(grant: Grant): Promise<void> {
    const value = JSON.stringify(GrantSchema.parse(grant));
    await this.secrets.set(grantName(grant.connection), value);
  }

  /** Changes a grant in place, one change at a time. Undefined when there is none. */
  update(connection: string, change: (grant: Grant) => Grant): Promise<Grant | undefined> {
    const prev = this.chain.get(connection) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(async () => {
        const grant = await this.get(connection);
        if (grant === undefined) return undefined;
        const changed = change(grant);
        await this.save(changed);
        return changed;
      });
    this.chain.set(connection, next);
    return next;
  }

  async delete(connection: string): Promise<void> {
    await this.secrets.delete(grantName(connection));
  }

  /** The connections that hold a grant. */
  async connections(): Promise<string[]> {
    const names = await this.secrets.names();
    return names
      .filter((n) => n.startsWith("oauth-"))
      .map((n) => n.slice("oauth-".length));
  }

  async registration(issuer: string, redirect: string): Promise<Registration | undefined> {
    const raw = await this.secrets.get(registrationName(issuer, redirect));
    if (raw === undefined) return undefined;
    try {
      const parsed = RegistrationSchema.safeParse(JSON.parse(raw));
      // A registration is only ever used with the issuer that made it.
      return parsed.success && parsed.data.issuer === issuer && parsed.data.redirect === redirect
        ? parsed.data
        : undefined;
    } catch {
      return undefined;
    }
  }

  async saveRegistration(registration: Registration): Promise<void> {
    await this.secrets.set(
      registrationName(registration.issuer, registration.redirect),
      JSON.stringify(RegistrationSchema.parse(registration)),
    );
  }
}
