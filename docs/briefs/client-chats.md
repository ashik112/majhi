# Client chats: one place for every chat app

Approved by the owner on 2026-10-07 (mockup: client chat in Chats, New chats, incident task with client status and RCA). Replaces section 4 of `docs/design/ship-without-me.md`. Read `docs/briefs/quality-bar.md` and CLAUDE.md first.

Owner rules that override everything here:

- **One system.** Every chat app (Telegram now; Slack, Discord, email next; Google Chat, WhatsApp, Messenger later) goes through the same stores and the same captain flow. No per-app trackers, inboxes or tables.
- **The owner controls the captain's permission**, per workspace, with the existing Tell row. Never "approve every message".
- **No BS tests.** Only the tests listed below. Run typecheck and touched tests while working; the full unit suite and e2e once before finishing.
- Sample names only in code, tests and docs (Acme, Globex).

## Owner answers (2026-10-07)

1. Telegram clients are in **groups**: the owner adds a majhi bot to each client group as admin (privacy mode then lets it see every message).
2. Slack clients are in the owner's **own workspace** (no Slack Connect needed first).
3. An RCA goes to a client **only after the owner's click**.

## Where everything lives

| Piece | Store | New |
|---|---|---|
| A chat app account (bot, app, mailbox) | Connections, new type `chat` with `app: telegram \| slack \| discord \| email`; tokens in secrets.age | Slack's existing `env` connection from `connect.appSave` becomes a `chat` connection (migration). |
| A client chat or channel | Rooms, new `ConversationKind` value `client` | `org` set when the owner links it; until then it is a New chat, never triaged. |
| A message | Room items, plus an `external` key `{app, account, chat, message}` | Unique index on the key: a repeat delivery is dropped. Edits keep a revision list. |
| Read position per account | the connection's runtime state (where connection health already lives) | Telegram offset, Slack latest ts per channel. Saved only after the batch is stored. |
| Who the client is | **New table `contacts` (id, org, name, tz, lang) + `contact_ids` (contact, app, account, native user id, unique)** | The only new store. A merge is reversible (merge log row). Never auto-merged by name. |
| What to do with a message | Findings, new source `client` (Laya first pass, existing dedupe) | The captain decides: ignore, answer, ask the owner, attach to an open incident, or open a task. |
| The incident | Tasks: type `incident`, new origin kind `client {room, item}`; the firing watch attaches through task links | One incident can link several client rooms; each gets updates. |
| What the client sees | Derived: Investigating, Identified, Monitoring, Resolved from the task, its deploy records and its watch | Resolved only after the linked watch stays green for the soak (default 15 min). Not stored. |
| Replies | The existing OutboundGate (draft, batch, auto) + the Tell row + the secret scan, with a real transport per app | Reply goes to the same chat and thread. |
| RCA | One report room item in the task: internal and client versions | Built from recorded events only. Client version sent through the gate after the owner's click; text frozen once sent. |

## Permission (owner's control)

- The **Tell** authority row per workspace decides: `ask` (every client reply waits for the owner) or `decide` (the captain sends).
- Under `decide`, a per-workspace **Hold** list (part of the workspace's existing autonomy entry) holds these for the owner; each can be switched off by the owner: promised times, first message to a contact, a group with several client companies, anything after a gap in delivery, money or contract, security incident. Defaults: all on.
- Fixed, not switchable: a reply holding a secret, or naming another client or another workspace's data, always waits.
- An RCA to a client always waits (owner answer 3).
- The captain may propose a change to Tell or the Hold list through the existing proposal card; only the owner applies it.

## Adapters

One interface, in `apps/server/src/chat/`:

```ts
interface ChatAdapter {
  app: ChatApp;
  capabilities: { threads: boolean; edits: boolean; deletes: boolean; replyWindowHours?: number; maxText: number };
  start(conn, sink: (envelope: ChatEnvelope) => Promise<void>, cursor): Stop;   // read loop with catch-up from cursor
  send(conn, target: { chat; thread?; replyTo? }, text: string): Promise<{ message: string }>;
  file(conn, ref): Promise<{ path: string; type: string; bytes: number }>;
}
type ChatEnvelope = { kind: "new" | "edit" | "delete"; external: ExternalKey; sender: { id: string; name: string; bot: boolean }; text: string; files: FileRef[]; at: string; thread?: string; replyTo?: string; forwarded?: boolean };
```

Telegram first: `getUpdates` long polling (no public address), one poller per token (only the main server; preview and e2e servers never read chat apps), `deleteWebhook` only after the owner confirms when a webhook is set, offset saved after store, `allowed_updates` set explicitly, `migrate_to_chat_id` relinks the room, 403 marks the chat unreachable, 401 marks the connection needs a new token, per-chat send queue honouring `retry_after`, split at 4096, HTML parse mode with plain-text fallback, files fetched at once (20 MB cap).

## Rules the code enforces (from the edge-case review)

- Client text is data: the triage step has no tools; actions pass the authority rails. A secret pasted by a client is redacted before any agent sees it.
- Identity by native user id only; forwarded messages count as the forwarder; anonymous admins and unknown senders are "unverified" and never trigger actions; the owner's own messages and teammates' are "us" and switch the room's holder to You; other bots and our own echoes are ignored.
- Unlinked chats are ignored except one New chat row; a direct message from a stranger is ignored; per-sender inbound rate limit.
- A gap over the app's retention (Telegram 24 h) shows a gap marker in the room; replies drafted after a gap are held.
- One holder per room (Captain or You); a reply never goes out from both.
- A second report of an open incident attaches to it; a related watch alert links; "any update?" is answered from the derived status; the client says broken while the watch is green: the client wins.
- Updates at a cadence the workspace sets (default 30 min) and on each status change, never more.

## Phases

1. **Core and Telegram:** `chat` connection type and Telegram adapter, client rooms with New chats and linking, external keys and revisions, contacts with reversible merge, finding source `client`, the captain's triage into the existing flow, replies through the gate with real transport, Tell and the Hold list, UI per the mockup (Clients list per workspace, New chats, room header with Replies Captain/You, held reply card, same-person card, composer sends to the chat).
2. **Incident and RCA:** origin `client`, incident linking of client rooms and watch alerts, derived client status with soak, status card on the task, update cadence, RCA report item (internal and client), send after click.
3. **Slack:** Socket Mode adapter on the same interface, migrate the saved Slack tokens, backfill after a gap with `conversations.history`.

## Tests (only these)

1. External key uniqueness: the same delivery twice stores one item; an edit updates the item and keeps the revision.
2. Telegram cursor: the offset advances only after the batch is stored; a restart re-reads nothing stored and loses nothing.
3. Rails: a reply under Tell `ask` never sends; under `decide` a held class waits; a secret or another client's name always waits; an RCA always waits; triage cannot call tools.
4. Contacts: merge and undo restore both identities exactly.
5. Isolation: a client room of one workspace is never visible to another workspace's agents.
