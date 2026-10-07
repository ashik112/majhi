import { CHAT_BRIEF, PRIVATE, type Task } from "@majhi/shared";
import type { Store } from "../store/index.ts";

/**
 * Who may act on a task from outside it. An agent in an ordinary chat with the owner may reach a
 * task that chat made, or one the owner named in that chat, inside the chat's workspace. Nothing
 * else: not a task in another workspace, not one it has no link to, not another chat. A promoted
 * chat is its own task, so its lead reaches it (`self`) with the task's own tools.
 */
export type Reach = { ok: true; task: Task; how: "self" | "created" | "named" } | { ok: false; why: string };

export function reachFromChat(
  store: Pick<Store, "tasks" | "room">,
  caller: { task: string; agent: string },
  targetId: string,
): Reach {
  const target = store.tasks.get(targetId);
  if (target === undefined) return { ok: false, why: `There is no task ${targetId}.` };
  const from = store.tasks.get(caller.task);
  if (from === undefined) return { ok: false, why: "Your own task is gone." };
  if (target.id === from.id) {
    return from.kind !== "chat" && from.team[0] === caller.agent
      ? { ok: true, task: target, how: "self" }
      : { ok: false, why: "Only the lead of a task acts on it." };
  }
  if (from.kind !== "chat" || from.brief !== CHAT_BRIEF || !from.team.includes(caller.agent)) {
    return { ok: false, why: "Only an agent in its own chat with the owner reaches another task this way." };
  }
  if (target.kind === "chat") return { ok: false, why: `${target.id} is a chat, not a task.` };
  if (from.org !== undefined && (target.org ?? PRIVATE) !== from.org) {
    return { ok: false, why: `${target.id} is in another workspace than this chat.` };
  }
  if (target.origin?.kind === "chat" && target.origin.room === from.id) {
    return { ok: true, task: target, how: "created" };
  }
  const named = store.room
    .ofType(from.id, "owner")
    .some((i) => i.type === "owner" && namesTask(i.text, target.id));
  if (named) return { ok: true, task: target, how: "named" };
  return {
    ok: false,
    why: `${target.id} is not a task this chat made, and the owner has not named it here. Ask the owner which task they mean.`,
  };
}

/** True when `text` holds the task id as a word of its own: not inside a longer id like `GOA-110`. */
export function namesTask(text: string, id: string): boolean {
  for (let at = text.indexOf(id); at !== -1; at = text.indexOf(id, at + 1)) {
    const before = at === 0 ? "" : (text[at - 1] ?? "");
    const after = text[at + id.length] ?? "";
    if (!isIdChar(before) && !isIdChar(after)) return true;
  }
  return false;
}

function isIdChar(c: string): boolean {
  if (c === "") return false;
  const code = c.charCodeAt(0);
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || c === "-";
}
