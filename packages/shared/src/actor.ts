import { z } from "zod";

/**
 * Who did something. The one shape every recorded action carries, and the only source of the words
 * a screen uses for it. A call arrives as `owner` or `agent`; the server turns the captain's agent
 * id into `captain` before it records anything (see `resolveActor`).
 */
export const ActorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("owner") }),
  z.object({ kind: z.literal("captain") }),
  z.object({ kind: z.literal("majhi") }),
  z.object({ kind: z.literal("agent"), id: z.string().min(1) }),
]);
export type Actor = z.infer<typeof ActorSchema>;

/** What a call arrives as: the owner or an agent. The server resolves an agent id to `captain` when it records. */
export const CallerSchema = z.discriminatedUnion("kind", [ActorSchema.options[0], ActorSchema.options[3]]);
export type Caller = z.infer<typeof CallerSchema>;

export const OWNER: Actor = { kind: "owner" };
export const CAPTAIN: Actor = { kind: "captain" };
export const MAJHI: Actor = { kind: "majhi" };

/** The subject of a sentence about an action: "You", "The captain", "@name", "majhi". */
export function actorWords(actor: Actor): string {
  switch (actor.kind) {
    case "owner":
      return "You";
    case "captain":
      return "The captain";
    case "majhi":
      return "majhi";
    case "agent":
      return `@${actor.id}`;
  }
}

/**
 * "You acknowledged it" or "The captain acknowledged it". Without a recorded actor (a row from
 * before actors were kept) it names no one: "Acknowledged it".
 */
export function didWords(actor: Actor | undefined, verb: string, rest = ""): string {
  const tail = rest === "" ? "" : ` ${rest}`;
  if (actor === undefined) return `${verb.charAt(0).toUpperCase()}${verb.slice(1)}${tail}`;
  return `${actorWords(actor)} ${verb}${tail}`;
}

/** The stored `by` strings (`owner`, `captain`, `majhi`, an agent id, or `agent:<id>`) as an Actor. */
export function actorOfName(name: string): Actor {
  if (name === "owner" || name === "you") return OWNER;
  if (name === "captain") return CAPTAIN;
  if (name === "majhi") return MAJHI;
  return { kind: "agent", id: name.startsWith("agent:") ? name.slice("agent:".length) : name };
}

/** `didWords` for the middle of a sentence: "you cancelled it", "the captain cancelled it". */
export function didWordsInline(actor: Actor | undefined, verb: string, rest = ""): string {
  const text = didWords(actor, verb, rest);
  return actor?.kind === "owner" || actor?.kind === "captain"
    ? `${text.charAt(0).toLowerCase()}${text.slice(1)}`
    : text;
}
