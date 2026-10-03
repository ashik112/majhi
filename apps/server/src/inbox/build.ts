import {
  type BudgetAsk,
  budgetDecisionId,
  type CaptainCapAsk,
  capDecisionId,
  type DecisionOption,
  type DecisionSuggestion,
  type OwnerDecision,
  type OwnerDecisionKind,
  type RoomItem,
  roomDecisionId,
  signInDecisionId,
} from "@majhi/shared";
import { oneLine, PAUSE_TEXT, type Subject } from "../notify/attention.ts";

/** The captain's stored opinion on a decision. */
export interface Recommendation {
  option: string;
  reason: string;
}

/** What decisions are built from. Every list is what waits right now. */
export interface DecisionSources {
  /** Pending room items of open tasks: cards that wait for the owner. */
  items: readonly RoomItem[];
  subject: (task: string) => Subject | undefined;
  caps: readonly CaptainCapAsk[];
  budgets: readonly BudgetAsk[];
  /** Accounts the owner has to sign in again. */
  signedOut: readonly { id: string; at: string }[];
  recommendations: ReadonlyMap<string, Recommendation>;
}

/** "$40", "$7.50", "2M tokens", or both. */
function budgetText(b: BudgetAsk["cap"]): string {
  const parts: string[] = [];
  if (b.cost !== undefined) parts.push(Number.isInteger(b.cost) ? `$${b.cost}` : `$${b.cost.toFixed(2)}`);
  if (b.tokens !== undefined) {
    const t = b.tokens;
    const short = t >= 1_000_000 ? `${+(t / 1_000_000).toFixed(1)}M` : t >= 1_000 ? `${+(t / 1_000).toFixed(1)}k` : `${t}`;
    parts.push(`${short} tokens`);
  }
  return parts.join(" / ");
}

const PAUSE_TITLE: Record<string, string> = {
  limit: "Paused: the account hit its usage limit",
  error: "Paused after an error",
  "signed-out": "Paused: an account is signed out",
  loop: "Stopped: the agents are going in circles",
  blocked: "Blocked and waits for you",
};

interface Draft {
  kind: OwnerDecisionKind;
  title: string;
  options: DecisionOption[];
  /** The suggestion that comes with the card itself. */
  suggestion?: DecisionSuggestion;
}

/** The first option is the primary one, the rest follow in their order. */
function withPrimary(options: readonly { id: string; label: string }[], primary: string | undefined): DecisionOption[] {
  const at = options.findIndex((o) => o.id === primary);
  const first = at === -1 ? 0 : at;
  const ordered = options.map((o, i) => ({ ...o, i })).sort((a, b) => (a.i === first ? -1 : b.i === first ? 1 : a.i - b.i));
  return ordered.map(({ id, label }, i) => (i === 0 ? { id, label, primary: true as const } : { id, label }));
}

/**
 * The decision a room item stands for, or undefined when it waits for nobody: an answered card, an
 * agent's message, a pause the owner made. The one rule of what is a decision; alerts use it too.
 */
function draftOf(item: RoomItem, subject: Subject): Draft | undefined {
  switch (item.type) {
    case "ask": {
      if (item.state !== "pending") return undefined;
      const first = item.questions[0];
      const title = `@${item.agent} asks: ${oneLine(first?.question ?? "a question")}`;
      // Several questions need the card; one question is answered here.
      if (item.questions.length !== 1 || first === undefined) return { kind: "question", title, options: [] };
      const suggested = first.options.some((o) => o.id === first.default) ? first.default : undefined;
      return {
        kind: "question",
        title,
        options: withPrimary(first.options, suggested),
        ...(suggested === undefined
          ? {}
          : { suggestion: { option: suggested, reason: "The agent's suggestion", by: "agent" as const } }),
      };
    }
    case "choice":
      return item.state === "pending"
        ? { kind: "question", title: oneLine(item.question), options: withPrimary(item.options, undefined) }
        : undefined;
    case "owner-question":
      return item.state === "pending"
        ? {
            kind: "question",
            title: oneLine(item.text ?? `@${item.agent} is asking you something`),
            options: withPrimary(
              item.choices.map((label, i) => ({ id: `c${i}`, label })),
              undefined,
            ),
          }
        : undefined;
    case "permission": {
      if (item.state !== "pending") return undefined;
      const allow = item.options.find((o) => o.kind === "allow_once") ?? item.options.find((o) => o.kind.startsWith("allow"));
      return {
        kind: "approval",
        title: `@${item.agent} needs approval: ${oneLine(item.title)}`,
        options: withPrimary(
          item.options.map((o) => ({ id: o.id, label: o.name })),
          allow?.id,
        ),
      };
    }
    case "approval":
      return item.state === "pending"
        ? {
            kind: "approval",
            title: oneLine(item.summary),
            options: [
              { id: "approve", label: "Approve", primary: true },
              { id: "reject", label: "Reject" },
            ],
          }
        : undefined;
    case "secret-request":
      return item.state === "pending"
        ? { kind: "secret", title: `@${item.agent} needs a secret: ${oneLine(item.label)}`, options: [] }
        : undefined;
    case "review": {
      if (item.state !== "pending") return undefined;
      if (item.ready === undefined) return { kind: "ship", title: "Ready for review", options: [] };
      const option = subject.repos === 0 ? { id: "done", label: "Mark done" } : { id: "merge", label: "Merge" };
      return {
        kind: "ship",
        title: item.why === undefined ? "Ready to ship" : `Ready to ship. ${oneLine(item.why, 100)}`,
        options: [{ ...option, primary: true }],
        suggestion: { option: option.id, reason: oneLine(item.ready, 160), by: "captain" },
      };
    }
    case "paused": {
      const title = PAUSE_TITLE[item.reason];
      if (item.state !== "pending" || PAUSE_TEXT[item.reason] === undefined || title === undefined) return undefined;
      return {
        kind: "paused",
        title: item.why === undefined ? title : oneLine(`${title.split(":")[0]}: ${item.why}`),
        options: [{ id: "resume", label: "Resume", primary: true }],
      };
    }
    default:
      return undefined;
  }
}

/** Whether a room item is a decision. Alerts ask this, so what the inbox lists and what alerts say cannot differ. */
export function isDecisionItem(item: RoomItem, subject: Subject): boolean {
  return draftOf(item, subject) !== undefined;
}

/** The id of the decision a room item stands for. */
export function decisionIdOf(item: RoomItem): string {
  return roomDecisionId(item.task, item.id);
}

function priority(d: OwnerDecision): number {
  return d.kind === "ship" || d.kind === "budget" ? 0 : 1;
}

/**
 * Everything that waits for the owner as decisions: ship and budget first, then oldest first. Pure:
 * built from what the sources hold now, so an answered card or a raised budget is simply gone.
 */
export function buildDecisions(src: DecisionSources): OwnerDecision[] {
  const out: OwnerDecision[] = [];
  /** The captain's recommendation when it names an option the decision has, else the card's own suggestion. */
  const suggestion = (id: string, options: readonly DecisionOption[], own?: DecisionSuggestion) => {
    const stored = src.recommendations.get(id);
    if (stored !== undefined && options.some((o) => o.id === stored.option)) {
      return { suggestion: { option: stored.option, reason: stored.reason, by: "captain" as const } };
    }
    return own === undefined ? {} : { suggestion: own };
  };

  for (const item of src.items) {
    const subject = src.subject(item.task);
    if (subject === undefined) continue;
    const draft = draftOf(item, subject);
    if (draft === undefined) continue;
    const id = decisionIdOf(item);
    out.push({
      id,
      kind: draft.kind,
      ...(subject.org === undefined ? {} : { org: subject.org }),
      task: item.task,
      taskTitle: subject.title,
      ...(subject.chat ? { chat: true as const } : {}),
      title: draft.title,
      options: draft.options,
      ...suggestion(id, draft.options, draft.suggestion),
      at: item.at,
      link: subject.chat ? { kind: "chat", id: item.task } : { kind: "task", id: item.task, item: item.id },
    });
  }

  for (const ask of src.caps) {
    const id = capDecisionId(ask.org, ask.chore, ask.day);
    const options: DecisionOption[] = [
      { id: "raise", label: `Raise to ${ask.raiseTo} for today`, primary: true },
      { id: "leave", label: "Leave it" },
    ];
    out.push({
      id,
      kind: "cap",
      org: ask.org,
      title: oneLine(ask.text),
      options,
      ...suggestion(id, options),
      at: ask.at,
      link: { kind: "captain" },
    });
  }

  for (const ask of src.budgets) {
    const id = budgetDecisionId(ask.scope, ask.day);
    const options: DecisionOption[] = [
      { id: "raise", label: `Raise to ${budgetText(ask.raiseTo)} for today`, primary: true },
      { id: "leave", label: "Leave it" },
    ];
    out.push({
      id,
      kind: "budget",
      ...(ask.scope === "day" ? {} : { org: ask.scope }),
      title: oneLine(ask.text),
      options,
      ...suggestion(id, options),
      at: ask.at,
      link: { kind: "limits" },
    });
  }

  for (const account of src.signedOut) {
    out.push({
      id: signInDecisionId(account.id),
      kind: "sign-in",
      title: `Sign in ${account.id}: its agents cannot run until you do`,
      options: [],
      at: account.at,
      link: { kind: "account", id: account.id },
    });
  }

  return out.sort((a, b) => priority(a) - priority(b) || a.at.localeCompare(b.at));
}
