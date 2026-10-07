import {
  type BudgetAsk,
  batchDecisionId,
  budgetDecisionId,
  compareDecisions,
  type DecisionOption,
  type DecisionSuggestion,
  draftDecisionId,
  incidentDecisionId,
  OUTBOUND_CHANNEL_LABEL,
  type OutboundChannel,
  type Draft as OutboundDraft,
  type OwnerDecision,
  type OwnerDecisionKind,
  permissionOptionLabel,
  plainAuthorityText,
  type RoomItem,
  roomDecisionId,
  signInDecisionId,
  type TaskId,
} from "@majhi/shared";
import type { ClientDraftInfo } from "../chat/replies.ts";
import { oneLine, PAUSE_TEXT, type Subject } from "../notify/attention.ts";

/** What "Fix with agent" says to the lead of a task whose checks failed. */
export const FIX_CHECKS_TEXT =
  "The hand-off check failed on your latest commit. Read the failure with the hand-off tool, fix it, commit, and say when it is done.";

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
  budgets: readonly BudgetAsk[];
  /** Accounts the owner has to sign in again. */
  signedOut: readonly { id: string; at: string }[];
  recommendations: ReadonlyMap<string, Recommendation>;
  /**
   * Tasks in review that cannot merge now, by task id: why, and whether there is simply nothing to
   * merge (Mark done still works). A review card of such a task does not offer Merge.
   */
  shipBlocked?: ReadonlyMap<string, { why: string; empty: boolean }>;
  /** Drafts that wait for the owner one by one (the outbound gate, Draft mode). */
  drafts?: readonly OutboundDraft[];
  /** What a client reply draft answers: its chat, who wrote and why it waits. Absent for other channels. */
  clientDraft?: (draft: OutboundDraft) => ClientDraftInfo | undefined;
  /** Batches that are due in front of the owner: queued drafts of a channel in Batch mode. */
  batches?: readonly { org: string; channel: OutboundChannel; drafts: readonly OutboundDraft[] }[];
  /** High incidents nobody has acknowledged (the ops watch). */
  incidents?: readonly {
    id: number;
    org: string;
    title: string;
    at: string;
    escalated: boolean;
    /** A fix the owner is asked to approve (Watch anything). */
    question?: { text: string; options: { id: string; label: string }[] } | undefined;
  }[];
  /** A workspace's name, for the sentences that name it. */
  orgName?: (org: string) => string | undefined;
  /** Decisions another part of majhi builds itself: the trust ladder's notices, the monthly ceiling. */
  extras?: readonly OwnerDecision[];
}

/** "$40", "$7.50", "2M tokens", or both. */
function budgetText(b: BudgetAsk["cap"]): string {
  const parts: string[] = [];
  if (b.cost !== undefined) parts.push(Number.isInteger(b.cost) ? `$${b.cost}` : `$${b.cost.toFixed(2)}`);
  if (b.tokens !== undefined) {
    const t = b.tokens;
    const short =
      t >= 1_000_000
        ? `${+(t / 1_000_000).toFixed(1)}M`
        : t >= 1_000
          ? `${+(t / 1_000).toFixed(1)}k`
          : `${t}`;
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
  /** Why the main action cannot succeed now, in one line. */
  blocked?: string;
  /** What it is in a full sentence. Falls back to the title. */
  sentence?: string;
  options: DecisionOption[];
  /** The suggestion that comes with the card itself. */
  suggestion?: DecisionSuggestion;
}

/** The first option is the primary one, the rest follow in their order. */
function withPrimary(options: readonly DecisionOption[], primary: string | undefined): DecisionOption[] {
  const at = options.findIndex((o) => o.id === primary);
  const first = at === -1 ? 0 : at;
  const ordered = options
    .map((o, i) => ({ o, i }))
    .sort((a, b) => (a.i === first ? -1 : b.i === first ? 1 : a.i - b.i))
    .map(({ o }) => {
      const { primary: _drop, ...rest } = o;
      return rest;
    });
  return ordered.map((o, i) => (i === 0 ? { ...o, primary: true as const } : o));
}

/**
 * The decision a room item stands for, or undefined when it waits for nobody: an answered card, an
 * agent's message, a pause the owner made. The one rule of what is a decision; alerts use it too.
 */
function draftOf(
  item: RoomItem,
  subject: Subject,
  shipBlock?: { why: string; empty: boolean },
): Draft | undefined {
  // A card waits for the owner only while its task is in the state the card belongs to. A card left
  // from before (a review card of a task that moved on, a merge approval of a paused task) is no decision.
  const status = subject.status;
  const acting = status === undefined || status === "running" || status === "review";
  switch (item.type) {
    case "ask": {
      if (item.state !== "pending") return undefined;
      const first = item.questions[0];
      const title = `@${item.agent} asks: ${oneLine(first?.question ?? "a question")}`;
      const sentence = `@${item.agent} asks: ${first?.question ?? "a question"}`;
      // Several questions need the card; one question is answered here.
      if (item.questions.length !== 1 || first === undefined)
        return { kind: "question", title, sentence, options: [] };
      const suggested = first.options.some((o) => o.id === first.default) ? first.default : undefined;
      const typed: DecisionOption[] = first.freeText
        ? [{ id: "reply", label: "Write an answer", text: true }]
        : [];
      return {
        kind: "question",
        title,
        sentence,
        options: [...withPrimary(first.options, suggested), ...typed],
        ...(suggested === undefined
          ? {}
          : { suggestion: { option: suggested, reason: "The agent's suggestion", by: "agent" as const } }),
      };
    }
    case "choice":
      return item.state === "pending"
        ? {
            kind: "question",
            title: oneLine(item.question),
            sentence: item.question,
            options: withPrimary(item.options, undefined),
          }
        : undefined;
    case "owner-question":
      return item.state === "pending"
        ? {
            kind: "question",
            title: oneLine(item.text ?? `@${item.agent} is asking you something`),
            sentence: item.text ?? `@${item.agent} is asking you something`,
            options: withPrimary(
              item.choices.map((label, i) => ({ id: `c${i}`, label })),
              undefined,
            ),
          }
        : undefined;
    case "permission": {
      if (item.state !== "pending" || !acting) return undefined;
      const allow =
        item.options.find((o) => o.kind === "allow_once") ??
        item.options.find((o) => o.kind.startsWith("allow"));
      return {
        kind: "approval",
        title: `@${item.agent} needs approval: ${oneLine(item.title)}`,
        sentence: `@${item.agent} needs your approval: ${item.title}`,
        options: withPrimary(
          item.options.map((o) => ({
            id: o.id,
            label: permissionOptionLabel(o),
            ...(o.kind === "allow_once"
              ? { effect: "approve" as const }
              : o.kind === "reject_once"
                ? { effect: "leave" as const }
                : {}),
          })),
          allow?.id,
        ),
      };
    }
    case "approval":
      // A split the agent asked for is carried out once its subtasks exist: the card has nothing left to ask.
      if (
        item.command === "tasks.split" &&
        subject.newestSubtask !== undefined &&
        subject.newestSubtask >= item.at
      )
        return undefined;
      // The captain's proposal: the owner's Apply or Reject, whatever state the lane task is in. Never in a batch.
      if (item.state === "pending" && item.proposal !== undefined) {
        return {
          kind: "approval",
          title: oneLine(item.summary),
          sentence: item.summary,
          options: [
            { id: "approve", label: "Apply", primary: true },
            { id: "reject", label: "Reject" },
          ],
        };
      }
      return item.state === "pending" && acting
        ? {
            kind: "approval",
            title: oneLine(item.summary),
            sentence:
              item.reason === undefined || item.reason === ""
                ? `@${item.agent} wants to: ${item.summary}`
                : `@${item.agent} wants to: ${item.summary}. Its reason: ${item.reason}`,
            options: [
              { id: "approve", label: "Approve", primary: true, effect: "approve" },
              { id: "reject", label: "Reject", effect: "leave" },
            ],
          }
        : undefined;
    case "secret-request":
      return item.state === "pending"
        ? {
            kind: "secret",
            title: `@${item.agent} needs a secret: ${oneLine(item.label)}`,
            sentence: `@${item.agent} needs a secret from you: ${item.label}`,
            options: [],
          }
        : undefined;
    case "review": {
      if (item.state !== "pending" || (status !== undefined && status !== "review")) return undefined;
      // The one gate: while the hand-off check of the head has no verdict, nothing is ready to ship.
      // Alerts, the bell, the banner and Home all read decisions, so none of them says it either.
      if (subject.checks === "running") return undefined;
      const who = item.lead === undefined ? "The team" : `@${item.lead}`;
      const name = `"${subject.title}"`;
      const repos = subject.repos ?? 1;
      const merge = { id: "merge", label: "Merge" };
      const done = { id: "done", label: "Mark done" };
      const changes: DecisionOption = { id: "changes", label: "Ask for changes", text: true };
      // A batch merges only what the captain checked, and only the one option it suggests.
      const checked = item.ready !== undefined;
      const ship = (o: DecisionOption, id: string): DecisionOption =>
        checked && o.id === id ? { ...o, effect: "approve" } : o;
      const own = (repos === 0 ? [done, changes] : [merge, done, changes]).map((o) =>
        ship(o, repos === 0 ? "done" : "merge"),
      );
      if (shipBlock !== undefined && repos > 0) {
        // The server knows Merge fails: say what is wrong, and offer only what can work.
        const rest = shipBlock.empty ? [done, changes] : [changes];
        const why = sentenceOf(shipBlock.why);
        return {
          kind: "ship",
          title: `Finished: ${oneLine(subject.title, 120)}`,
          sentence: `${who} finished ${name}. It cannot be merged yet.`,
          blocked: why.slice(0, 300),
          options: withPrimary(rest, undefined),
        };
      }
      if (subject.checks === "failed" && repos > 0) {
        const fix: DecisionOption[] = item.lead === undefined ? [] : [{ id: "fix", label: "Fix with agent" }];
        return {
          kind: "ship",
          title: `Checks failed: ${oneLine(subject.title, 120)}`,
          sentence:
            `${who} finished ${name}, but its checks failed.${item.why === undefined ? "" : ` ${item.why}`}`.slice(
              0,
              500,
            ),
          options: withPrimary([...fix, done, changes], fix.length > 0 ? "fix" : undefined),
        };
      }
      if (item.ready === undefined) {
        return {
          kind: "ship",
          title: `Ready to ship: ${oneLine(subject.title, 120)}`,
          sentence:
            repos === 0
              ? `${who} finished ${name}. It has no repo, so there is nothing to merge: read it, then mark it done or ask for changes.`
              : `${who} finished ${name} and waits for your review.${item.why?.startsWith("Checks failed") === true ? ` ${item.why}` : ""}`.slice(
                  0,
                  500,
                ),
          options: withPrimary(own, undefined),
        };
      }
      const pick = repos === 0 ? "done" : "merge";
      return {
        kind: "ship",
        title: `Ready to ship: ${oneLine(subject.title, 120)}`,
        sentence:
          repos === 0
            ? `${who} finished ${name}. It has no repo, so it is ready to mark done.`
            : `${who} finished ${name} and it is ready to merge.`,
        options: withPrimary(own, pick),
        suggestion: { option: pick, reason: item.ready, by: "captain" },
      };
    }
    case "paused": {
      const title = PAUSE_TITLE[item.reason];
      if (item.state !== "pending" || PAUSE_TEXT[item.reason] === undefined || title === undefined)
        return undefined;
      // A task paused only because its subtasks are open waits for them, not for the owner.
      if ((status !== undefined && status !== "paused") || (subject.openSubtasks ?? 0) > 0) return undefined;
      return {
        kind: "paused",
        title: item.why === undefined ? title : oneLine(`${title.split(":")[0]}: ${item.why}`),
        sentence: `"${subject.title}" ${item.why === undefined ? `${title.charAt(0).toLowerCase()}${title.slice(1)}` : `is paused: ${item.why}`}`,
        options: [{ id: "resume", label: "Resume", primary: true, effect: "approve" }],
      };
    }
    default:
      return undefined;
  }
}

/** A reason as a sentence: capital first, full stop last. */
function sentenceOf(text: string): string {
  const flat = text.trim();
  const capped = `${flat.charAt(0).toUpperCase()}${flat.slice(1)}`;
  return /[.!?]$/.test(capped) ? capped : `${capped}.`;
}

/** Whether a room item is a decision. Alerts ask this, so what the inbox lists and what alerts say cannot differ. */
export function isDecisionItem(item: RoomItem, subject: Subject): boolean {
  return draftOf(item, subject) !== undefined;
}

/** The id of the decision a room item stands for. */
export function decisionIdOf(item: RoomItem): string {
  return roomDecisionId(item.task, item.id);
}

/**
 * Everything that waits for the owner as decisions: ship and budget first, then oldest first. Pure:
 * built from what the sources hold now, so an answered card or a raised budget is simply gone.
 */
export function buildDecisions(src: DecisionSources): OwnerDecision[] {
  const out: OwnerDecision[] = [];
  /**
   * The options and the suggestion. The captain's recommendation wins when it names an option the
   * decision has, else the card's own suggestion; the suggested option goes first, as the primary one.
   */
  const decorate = (
    id: string,
    options: DecisionOption[],
    own?: DecisionSuggestion,
    workspace?: string,
    question = false,
  ) => {
    const stored = src.recommendations.get(id);
    const picked: DecisionSuggestion | undefined =
      stored !== undefined && options.some((o) => o.id === stored.option)
        ? { option: stored.option, reason: stored.reason, by: "captain" }
        : own;
    // Reasons stored before the authority table name levels that no screen has any more.
    const chosen =
      picked === undefined
        ? undefined
        : { ...picked, reason: plainAuthorityText(picked.reason, workspace).slice(0, 600) };
    if (chosen === undefined) return { options };
    const ordered = withPrimary(options, chosen.option);
    // On a question, the suggested option is what a batch approves; other kinds mark theirs already.
    return {
      options: question
        ? ordered.map((o) =>
            o.id === chosen.option && o.text !== true ? { ...o, effect: "approve" as const } : o,
          )
        : ordered,
      suggestion: chosen,
    };
  };

  for (const item of src.items) {
    const subject = src.subject(item.task);
    if (subject === undefined) continue;
    const draft = draftOf(
      item,
      subject,
      item.type === "review" ? src.shipBlocked?.get(item.task) : undefined,
    );
    if (draft === undefined) continue;
    const id = decisionIdOf(item);
    const workspace = subject.org === undefined ? undefined : src.orgName?.(subject.org);
    out.push({
      id,
      kind: draft.kind,
      ...(subject.org === undefined ? {} : { org: subject.org }),
      task: item.task,
      taskTitle: subject.title,
      ...(subject.chat ? { chat: true as const } : {}),
      title: draft.title,
      sentence: draft.sentence ?? draft.title,
      ...(draft.blocked === undefined ? {} : { blocked: draft.blocked }),
      ...decorate(id, draft.options, draft.suggestion, workspace, draft.kind === "question"),
      at: item.at,
      link: subject.chat ? { kind: "chat", id: item.task } : { kind: "task", id: item.task, item: item.id },
    });
  }

  for (const ask of src.budgets) {
    const id = budgetDecisionId(ask.scope, ask.day);
    const options: DecisionOption[] = [
      {
        id: "raise",
        label: `Raise to ${budgetText(ask.raiseTo)} for today`,
        primary: true,
        effect: "approve",
      },
      { id: "leave", label: "Leave it", effect: "leave" },
    ];
    out.push({
      id,
      kind: "budget",
      ...(ask.scope === "day" ? {} : { org: ask.scope }),
      title: oneLine(ask.text),
      sentence: ask.text,
      ...decorate(id, options),
      at: ask.at,
      link: { kind: "limits" },
    });
  }

  for (const d of src.drafts ?? []) {
    const id = draftDecisionId(d.id);
    const what = OUTBOUND_CHANNEL_LABEL[d.channel].toLowerCase();
    const options: DecisionOption[] = [
      { id: "send", label: "Approve", primary: true },
      { id: "discard", label: "Discard" },
    ];
    const client = d.channel === "client" ? src.clientDraft?.(d) : undefined;
    if (client !== undefined) {
      const who = client.from === undefined ? "a client" : client.from;
      const said = client.said === undefined ? "" : ` ${client.from ?? "They"} wrote: "${oneLine(client.said).slice(0, 160)}".`;
      const why = client.hold === undefined ? "" : ` Waiting because: ${client.hold}.`;
      out.push({
        id,
        kind: "reply",
        org: d.org,
        title: oneLine(`Reply to ${who} in ${client.chat} (${client.app}): ${d.body}`),
        sentence: `A reply to ${who} in ${client.chat} (${client.app}) is ready.${said}${why} Nothing is sent until you approve it.`,
        ...decorate(id, options, undefined, src.orgName?.(d.org)),
        at: d.createdAt,
        link: { kind: "chat", id: client.room as TaskId },
      });
      continue;
    }
    const head = d.subject ?? d.body;
    out.push({
      id,
      kind: "draft",
      org: d.org,
      title: oneLine(`${OUTBOUND_CHANNEL_LABEL[d.channel]} to ${d.target}: ${head}`),
      sentence: `A ${what} to ${d.target} is drafted${d.voice === undefined ? "" : ` in the voice "${d.voice}"`}. Nothing is sent until you approve it.`,
      ...decorate(id, options, undefined, src.orgName?.(d.org)),
      at: d.createdAt,
      link: { kind: "playbooks" },
    });
  }

  for (const b of src.batches ?? []) {
    const id = batchDecisionId(b.org, b.channel);
    const options: DecisionOption[] = [
      { id: "send", label: `Approve all ${b.drafts.length}`, primary: true },
      { id: "discard", label: "Discard all" },
    ];
    const label = OUTBOUND_CHANNEL_LABEL[b.channel].toLowerCase();
    out.push({
      id,
      kind: "batch",
      org: b.org,
      title: `${b.drafts.length} ${label} ${b.drafts.length === 1 ? "draft is" : "drafts are"} ready to approve`,
      sentence: `${b.drafts.length} ${label} ${b.drafts.length === 1 ? "draft waits" : "drafts wait"} in this batch. Nothing is sent until you approve.`,
      ...decorate(id, options, undefined, src.orgName?.(b.org)),
      at: b.drafts[0]?.createdAt ?? new Date(0).toISOString(),
      link: { kind: "playbooks" },
    });
  }

  for (const inc of src.incidents ?? []) {
    const id = incidentDecisionId(inc.id);
    const options: DecisionOption[] =
      inc.question === undefined
        ? [{ id: "ack", label: "Acknowledge", primary: true }]
        : inc.question.options.map((o, i) => ({
            id: o.id,
            label: o.label,
            ...(i === 0 ? { primary: true as const } : {}),
          }));
    out.push({
      id,
      kind: "incident",
      org: inc.org,
      title: oneLine(inc.escalated ? `${inc.title} (not acknowledged yet)` : inc.title),
      sentence:
        inc.question !== undefined
          ? oneLine(`${inc.title}. ${inc.question.text}`).slice(0, 500)
          : inc.escalated
            ? `${inc.title}. majhi alerted you twice and nobody has acknowledged it. Acknowledging stops the alerts; it closes when its checks are green.`
            : `${inc.title}. Acknowledging stops the alerts; it closes when its checks are green.`,
      options,
      at: inc.at,
      link: { kind: "watch" },
    });
  }

  for (const account of src.signedOut) {
    out.push({
      id: signInDecisionId(account.id),
      kind: "sign-in",
      title: `Sign in ${account.id}: its agents cannot run until you do`,
      sentence: `${account.id} is signed out. Its agents cannot run until you sign in again.`,
      options: [],
      at: account.at,
      link: { kind: "account", id: account.id },
    });
  }

  out.push(...(src.extras ?? []));
  return out.sort(compareDecisions);
}
