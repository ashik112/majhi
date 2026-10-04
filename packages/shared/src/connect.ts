import { z } from "zod";
import { ConnectionTestResultSchema } from "./connections.ts";
import { IdSchema } from "./ids.ts";
import { ServiceEntrySchema } from "./services.ts";

/**
 * Connect (SPEC 5.14): joining a service with one click. A grant is what majhi holds for one
 * connection of one workspace: tokens in secrets.age, never anywhere else. The views here carry
 * no token, code, state or client secret.
 */

/**
 * Where a grant stands.
 * - `connected`: the token works or renews itself.
 * - `needs-reconnect`: the service no longer takes the renewal; the owner signs in again.
 * - `insufficient-scope`: the token works, but a step needs more access than the owner gave.
 * - `revoked`: the owner or the service ended the grant; the token is gone.
 * - `error`: the last check failed for a reason that is not the grant (the service is down).
 */
export const ConnectStateSchema = z.enum([
  "connected",
  "needs-reconnect",
  "insufficient-scope",
  "revoked",
  "error",
]);
export type ConnectState = z.infer<typeof ConnectStateSchema>;

export const ConnectScopeLineSchema = z.object({
  access: z.enum(["read", "write", "other"]),
  sentence: z.string(),
});
export type ConnectScopeLine = z.infer<typeof ConnectScopeLineSchema>;

/** What majhi holds for one connection, without the token. */
export const ConnectStatusSchema = z.object({
  connection: IdSchema,
  org: IdSchema,
  /** The catalog entry, absent for a server that is not in the catalog. */
  service: IdSchema.optional(),
  serviceName: z.string(),
  state: ConnectStateSchema,
  /** One sentence for the state, with the exact next step when there is one. */
  reason: z.string(),
  /** Who signed in, as the service told majhi. Absent when the service does not say. */
  account: z.string().optional(),
  scopes: z.array(ConnectScopeLineSchema),
  /** Access the next step asked for and the grant lacks. */
  missing: z.array(z.string()),
  connectedAt: z.string().optional(),
  /** When the access token ends. majhi renews it before then when the service gave a renewal. */
  expiresAt: z.string().optional(),
  renews: z.boolean(),
  /** The grant can be revoked at the service when the owner disconnects. */
  revocable: z.boolean(),
});
export type ConnectStatus = z.infer<typeof ConnectStatusSchema>;

/**
 * One connect attempt, from the click to the result.
 * - `waiting`: the browser page is open (or its link is shown) and majhi waits.
 * - `checking`: the owner approved; majhi is exchanging the code and testing.
 * - `confirm-account`: a reconnect signed in as a different account; nothing changed yet.
 * - `connected`, `denied`, `expired`, `failed`, `cancelled`: ended.
 */
export const ConnectFlowStateSchema = z.enum([
  "waiting",
  "checking",
  "confirm-account",
  "connected",
  "denied",
  "expired",
  "failed",
  "cancelled",
]);
export type ConnectFlowState = z.infer<typeof ConnectFlowStateSchema>;

export const ConnectFlowViewSchema = z.object({
  flow: z.string(),
  org: IdSchema,
  service: IdSchema,
  serviceName: z.string(),
  /** Set for a reconnect, and once a first connect has made its connection. */
  connection: IdSchema.optional(),
  state: ConnectFlowStateSchema,
  /** One or two sentences. Never holds a token, a code or the service's error text. */
  message: z.string(),
  /** The page to open, shown while waiting when the host helper could not open it. */
  url: z.string().optional(),
  /** The helper opened the page. */
  opened: z.boolean(),
  /** The device code the owner types on the page, for a sign-in with a code. Not a secret. */
  code: z.string().optional(),
  /** Who signed in, once known. */
  account: z.string().optional(),
  /** For `confirm-account`: the account the connection had. */
  previousAccount: z.string().optional(),
  scopes: z.array(ConnectScopeLineSchema),
  /** The test after connecting. */
  test: ConnectionTestResultSchema.optional(),
  /** When the waiting page stops working. */
  expiresAt: z.string(),
});
export type ConnectFlowView = z.infer<typeof ConnectFlowViewSchema>;

export const ConnectCatalogSchema = z.object({
  services: z.array(ServiceEntrySchema),
  /** The address the service sends the owner back to. */
  redirect: z.string(),
  /** The host helper can open the page. When false the page shows the link. */
  helper: z.boolean(),
});
export type ConnectCatalog = z.infer<typeof ConnectCatalogSchema>;

/**
 * How much access to ask for: read first; `readwrite` adds drafts and edits when the owner turns on a
 * pack that writes; `send` adds sending, only for a pack the owner lets send.
 */
export const ConnectAccessSchema = z.enum(["read", "readwrite", "send"]);
export type ConnectAccess = z.infer<typeof ConnectAccessSchema>;

export const ConnectStartInputSchema = z.object({
  org: IdSchema,
  service: IdSchema,
  access: ConnectAccessSchema.default("read"),
  /** Set to sign in again for an existing connection. */
  connection: IdSchema.optional(),
});
export type ConnectStartInput = z.infer<typeof ConnectStartInputSchema>;

export const ConnectFlowInputSchema = z.object({ flow: z.string().min(8).max(100) });

export const ConnectConfirmInputSchema = ConnectFlowInputSchema.extend({
  /** True replaces the connection's account with the one that just signed in. */
  accept: z.boolean(),
});

export const ConnectDisconnectResultSchema = z.object({
  removed: IdSchema,
  /** The service took the revoke. When false, `note` says what stays and where to remove it. */
  revoked: z.boolean(),
  note: z.string(),
});
export type ConnectDisconnectResult = z.infer<typeof ConnectDisconnectResultSchema>;

export const ConnectNeedScopeInputSchema = z.object({
  connection: IdSchema,
  /** The scope the service's 403 named, when it named one. */
  scope: z.string().trim().min(1).max(200).optional(),
});
