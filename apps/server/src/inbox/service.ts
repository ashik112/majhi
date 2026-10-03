import {
  type CardAction,
  type DecisionAnswerInput,
  type DecisionDetail,
  type DecisionRecommendInput,
  type OwnerDecision,
  PRIVATE,
  type RepoDiff,
  parseDecisionId,
  type RoomItem,
  type ShipOptions,
} from "@majhi/shared";
import { UserError } from "../errors.ts";
import type { Subject } from "../notify/attention.ts";
import { buildDecisions, type DecisionSources, type Recommendation } from "./build.ts";
import { splitReady } from "./plain.ts";

/** The paths a decision is answered through: the same ones its card uses. */
export interface DecisionActions {
  answerAsk(task: string, item: string, answers: Record<string, string>): Promise<unknown>;
  answerQuestion(task: string, item: string, choice: string): Promise<unknown>;
  answerChoice(task: string, item: string, option: string): Promise<unknown>;
  answerPermission(task: string, item: string, option: string): unknown;
  decideApproval(task: string, item: string, decision: "approve" | "reject"): Promise<unknown>;
  /** Resolves with what each repo's merge did; the card stays pending when one failed. */
  cardAction(
    task: string,
    item: string,
    action: CardAction,
  ): Promise<{ results?: readonly { project: string; ok: boolean; detail: string }[] | undefined }>;
  /** The owner's words to the task's lead: the task goes back to running. */
  askChanges(task: string, text: string, lead: string | undefined): Promise<unknown>;
  answerCap(org: string, chore: string, answer: "raise" | "leave"): Promise<unknown>;
  answerBudget(scope: string, answer: "raise" | "leave"): Promise<unknown>;
}

export interface RecommendationStore {
  all(): Map<string, Recommendation>;
  set(id: string, rec: Recommendation, at: string): void;
  /** Forgets recommendations of decisions that are gone and older than `before`. */
  prune(keep: ReadonlySet<string>, before: string): void;
}

export interface InboxDeps {
  /** Pending room items that may be decisions, of every open task. */
  items: () => RoomItem[];
  subject: (task: string) => Subject | undefined;
  caps: () => Promise<DecisionSources["caps"]>;
  budgets: () => Promise<DecisionSources["budgets"]>;
  signedOut: () => Promise<DecisionSources["signedOut"]>;
  recommendations: RecommendationStore;
  actions: DecisionActions;
  /** Workspace names by id, for the sentences that name one. */
  orgNames?: () => Promise<Readonly<Record<string, string>>>;
  /** The agent's last message in the task. */
  lastAgentMessage?: (task: string) => { agent: string; text: string; at: string } | undefined;
  diff?: (task: string) => Promise<RepoDiff[]>;
  shipOptions?: (task: string) => Promise<ShipOptions>;
  now?: () => Date;
}

/** Recommendations of decisions that are gone are kept this long, then forgotten. */
const NO_NAMES: Readonly<Record<string, string>> = {};
const KEEP_MS = 14 * 24 * 3_600_000;

/**
 * The owner's inbox (SPEC 5.18): lists what waits as decisions and answers one through the path its
 * card already has. Nothing here stores a decision, only the captain's recommendation.
 */
export class InboxService {
  constructor(private readonly deps: InboxDeps) {}

  async list(org?: string): Promise<OwnerDecision[]> {
    const { deps } = this;
    const [caps, budgets, signedOut, names] = await Promise.all([
      deps.caps(),
      deps.budgets(),
      deps.signedOut(),
      deps.orgNames?.() ?? NO_NAMES,
    ]);
    const all = buildDecisions({
      items: deps.items(),
      subject: deps.subject,
      caps,
      budgets,
      signedOut,
      recommendations: deps.recommendations.all(),
      orgName: (org) => names[org],
    });
    const now = (deps.now?.() ?? new Date()).getTime();
    deps.recommendations.prune(new Set(all.map((d) => d.id)), new Date(now - KEEP_MS).toISOString());
    return org === undefined ? all : all.filter((d) => d.org === org);
  }

  /** The decisions left after the answer, so a screen can show them without asking again. */
  async answer(input: DecisionAnswerInput): Promise<OwnerDecision[]> {
    const decision = (await this.list()).find((d) => d.id === input.id);
    if (decision === undefined) throw new UserError("That decision is gone: it was answered already.", 409);
    const option = decision.options.find((o) => o.id === input.option);
    if (option === undefined) {
      throw new UserError(`"${input.option}" is not one of the options. Open the task to answer it.`, 400);
    }
    if (option.text === true && (input.text === undefined || input.text.trim() === "")) {
      throw new UserError("Write your answer first.", 400);
    }
    const parsed = parseDecisionId(input.id);
    if (parsed === undefined) throw new UserError("That is not a decision id.", 400);
    const { actions } = this.deps;
    if (parsed.kind === "cap") await actions.answerCap(parsed.org, parsed.chore, raiseOrLeave(input.option));
    else if (parsed.kind === "budget") await actions.answerBudget(parsed.scope, raiseOrLeave(input.option));
    else if (parsed.kind === "signin") throw new UserError("Sign in from Accounts.", 400);
    else {
      const item = this.deps.items().find((i) => i.task === parsed.task && i.id === parsed.item);
      if (item === undefined) throw new UserError("That decision is gone: it was answered already.", 409);
      await this.answerCard(item, input);
    }
    return this.list();
  }

  private async answerCard(item: RoomItem, input: DecisionAnswerInput): Promise<void> {
    const { actions } = this.deps;
    switch (item.type) {
      case "ask": {
        const question = item.questions[0];
        if (item.questions.length !== 1 || question === undefined) {
          throw new UserError("This card has several questions. Open the task.", 400);
        }
        await actions.answerAsk(item.task, item.id, { [question.id]: input.text ?? input.option });
        return;
      }
      case "owner-question": {
        const choice = item.choices[Number(input.option.slice(1))];
        if (choice === undefined) throw new UserError("That choice is gone.", 400);
        await actions.answerQuestion(item.task, item.id, choice);
        return;
      }
      case "choice":
        await actions.answerChoice(item.task, item.id, input.option);
        return;
      case "permission":
        actions.answerPermission(item.task, item.id, input.option);
        return;
      case "approval":
        await actions.decideApproval(item.task, item.id, input.option === "reject" ? "reject" : "approve");
        return;
      case "review": {
        if (input.option === "changes") {
          await actions.askChanges(item.task, (input.text ?? "").trim(), item.lead);
          return;
        }
        const out = await actions.cardAction(item.task, item.id, input.option === "done" ? "done" : "merge");
        const failed = out.results?.find((r) => !r.ok);
        if (failed !== undefined) {
          throw new UserError(`Could not merge ${failed.project}: ${failed.detail}`, 409);
        }
        return;
      }
      case "paused":
        await actions.cardAction(item.task, item.id, "resume");
        return;
      default:
        throw new UserError("That decision is answered in the task. Open it.", 400);
    }
  }

  /**
   * What the owner needs to decide one decision without opening the task. Read for the selected
   * decision only: the diff and the room are not free to read for every row.
   */
  async detail(id: string): Promise<DecisionDetail> {
    const decision = (await this.list()).find((d) => d.id === id);
    if (decision === undefined) throw new UserError("That decision is gone: it was answered already.", 404);
    const { deps } = this;
    const out: DecisionDetail = { id };
    const parsed = parseDecisionId(id);
    if (parsed?.kind !== "room") return out;
    const item = deps.items().find((i) => i.task === parsed.task && i.id === parsed.item);
    const handback = deps.lastAgentMessage?.(parsed.task);
    if (handback !== undefined) out.handback = handback;
    if (item?.type === "ask") {
      out.questions = item.questions.map((q) => ({
        question: q.question,
        options: q.options.map((o) => o.label),
        freeText: q.freeText,
      }));
    }
    if (item?.type === "review") {
      const workspace = decision.org === undefined ? undefined : (await deps.orgNames?.())?.[decision.org];
      const checks = item.ready === undefined ? undefined : splitReady(item.ready, workspace).checks;
      if (checks !== undefined) out.checks = checks;
      if (deps.diff !== undefined) Object.assign(out, await this.readDiff(parsed.task));
      const blocked = await this.blockedOptions(parsed.task, decision);
      if (Object.keys(blocked).length > 0) out.blocked = blocked;
    }
    return out;
  }

  private async readDiff(task: string): Promise<Pick<DecisionDetail, "diff" | "repos">> {
    let diffs: RepoDiff[];
    try {
      diffs = (await this.deps.diff?.(task)) ?? [];
    } catch (err) {
      const reason = err instanceof Error ? err.message : "unknown error";
      return { diff: { files: 0, additions: 0, deletions: 0, top: [], uncommitted: false, error: reason } };
    }
    if (diffs.length === 0) return {};
    const many = diffs.length > 1;
    const files = diffs.flatMap((d) =>
      d.files.map((f) => ({
        path: many ? `${d.project}/${f.path}` : f.path,
        additions: f.additions,
        deletions: f.deletions,
      })),
    );
    const error = diffs.find((d) => d.error !== undefined)?.error;
    const omitted = diffs.reduce((n, d) => n + d.omitted, 0);
    return {
      diff: {
        files: files.length + omitted,
        additions: files.reduce((n, f) => n + f.additions, 0),
        deletions: files.reduce((n, f) => n + f.deletions, 0),
        top: [...files].sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions)).slice(0, 6),
        uncommitted: diffs.some((d) => d.uncommitted),
        ...(error === undefined ? {} : { error }),
      },
      repos: diffs.map((d) => ({ project: d.project, branch: d.branch, into: d.base })),
    };
  }

  /** Why Merge or Mark done cannot be taken now, for the options this review decision offers. */
  private async blockedOptions(task: string, decision: OwnerDecision): Promise<Record<string, string>> {
    const blocked: Record<string, string> = {};
    let ship: ShipOptions;
    try {
      if (this.deps.shipOptions === undefined) return blocked;
      ship = await this.deps.shipOptions(task);
    } catch {
      return blocked;
    }
    const offers = (id: string) => decision.options.some((o) => o.id === id);
    if (offers("merge") && !ship.merge.ok) blocked.merge = ship.merge.why ?? "It cannot merge now.";
    if (offers("done")) {
      const left = ship.done.unshipped ?? [];
      if (!ship.done.ok) blocked.done = ship.done.why ?? "It cannot be marked done now.";
      else if (left.length > 0) blocked.done = "Some commits are not merged yet. Merge first.";
    }
    return blocked;
  }

  /**
   * The captain's recommendation, from its lane `lane` (a workspace id). Refused for another
   * workspace's decision and for an option the decision does not offer.
   */
  async recommend(input: DecisionRecommendInput, lane: string | undefined): Promise<void> {
    const decision = (await this.list()).find((d) => d.id === input.id);
    if (decision === undefined) throw new UserError("That decision is gone. List decisions again.", 404);
    const own = decision.org ?? (decision.task === undefined ? undefined : PRIVATE);
    if (lane !== undefined && own !== undefined && own !== lane) {
      throw new UserError("That decision belongs to another workspace.", 409);
    }
    if (!decision.options.some((o) => o.id === input.option)) {
      const names = decision.options.map((o) => o.id).join(", ");
      throw new UserError(
        names === "" ? "That decision has no buttons to recommend." : `Option must be one of: ${names}.`,
        400,
      );
    }
    this.deps.recommendations.set(
      input.id,
      { option: input.option, reason: input.reason },
      (this.deps.now?.() ?? new Date()).toISOString(),
    );
  }
}

function raiseOrLeave(option: string): "raise" | "leave" {
  return option === "raise" ? "raise" : "leave";
}
