import {
  type CardAction,
  type DecisionAnswerInput,
  type DecisionRecommendInput,
  type OwnerDecision,
  PRIVATE,
  parseDecisionId,
  type RoomItem,
} from "@majhi/shared";
import { UserError } from "../errors.ts";
import type { Subject } from "../notify/attention.ts";
import { buildDecisions, type DecisionSources, type Recommendation } from "./build.ts";

/** The paths a decision is answered through: the same ones its card uses. */
export interface DecisionActions {
  answerAsk(task: string, item: string, answers: Record<string, string>): Promise<unknown>;
  answerQuestion(task: string, item: string, choice: string): Promise<unknown>;
  answerChoice(task: string, item: string, option: string): Promise<unknown>;
  answerPermission(task: string, item: string, option: string): unknown;
  decideApproval(task: string, item: string, decision: "approve" | "reject"): Promise<unknown>;
  cardAction(task: string, item: string, action: CardAction): Promise<unknown>;
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
  now?: () => Date;
}

/** Recommendations of decisions that are gone are kept this long, then forgotten. */
const KEEP_MS = 14 * 24 * 3_600_000;

/**
 * The owner's inbox (SPEC 5.18): lists what waits as decisions and answers one through the path its
 * card already has. Nothing here stores a decision, only the captain's recommendation.
 */
export class InboxService {
  constructor(private readonly deps: InboxDeps) {}

  async list(org?: string): Promise<OwnerDecision[]> {
    const { deps } = this;
    const [caps, budgets, signedOut] = await Promise.all([deps.caps(), deps.budgets(), deps.signedOut()]);
    const all = buildDecisions({
      items: deps.items(),
      subject: deps.subject,
      caps,
      budgets,
      signedOut,
      recommendations: deps.recommendations.all(),
    });
    const now = (deps.now?.() ?? new Date()).getTime();
    deps.recommendations.prune(new Set(all.map((d) => d.id)), new Date(now - KEEP_MS).toISOString());
    return org === undefined ? all : all.filter((d) => d.org === org);
  }

  /** The decisions left after the answer, so a screen can show them without asking again. */
  async answer(input: DecisionAnswerInput): Promise<OwnerDecision[]> {
    const decision = (await this.list()).find((d) => d.id === input.id);
    if (decision === undefined) throw new UserError("That decision is gone: it was answered already.", 409);
    if (!decision.options.some((o) => o.id === input.option)) {
      throw new UserError(`"${input.option}" is not one of the options. Open the task to answer it.`, 400);
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
      case "review":
        await actions.cardAction(item.task, item.id, input.option === "done" ? "done" : "merge");
        return;
      case "paused":
        await actions.cardAction(item.task, item.id, "resume");
        return;
      default:
        throw new UserError("That decision is answered in the task. Open it.", 400);
    }
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
