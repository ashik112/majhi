import type { DecisionList, OwnerDecision } from "@majhi/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";
import { useToast } from "@/components/ui/toast";
import { cmd } from "@/lib/api";
import { useAnswerDecision } from "@/lib/decision-queries";
import { describeError } from "@/lib/errors";
import { queryKeys } from "@/lib/queries";
import { rowTitle } from "./model";

/** How long a one-click answer to a question waits before it is sent, as in the room. */
export const UNDO_MS = 5000;

interface Hold {
  option: string;
  timer: number;
}

/** Answers waiting out their undo time, by decision. Module state: a page change must not drop one. */
const holds = new Map<string, Hold>();
const listeners = new Set<() => void>();
let version = 0;

function changed(): void {
  version += 1;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The option of a decision that waits to be sent, or undefined. */
export function useHeldOption(id: string): string | undefined {
  useSyncExternalStore(subscribe, () => version);
  return holds.get(id)?.option;
}

/** The kinds whose buttons are short fixed verbs, so a failure can name the action ("Could not merge"). */
const VERB_KINDS: ReadonlySet<OwnerDecision["kind"]> = new Set(["ship", "paused", "approval", "budget"]);

/** "Could not merge", "Could not allow once": what failed, from the button's own words. */
export function failureTitle(decision: Pick<OwnerDecision, "kind">, label: string, typed: boolean): string {
  const words = label.trim().toLowerCase();
  return typed || words === "" || words.length > 40 || !VERB_KINDS.has(decision.kind)
    ? "Could not answer it"
    : `Could not ${words}`;
}

interface SendOptions {
  text?: string | undefined;
  /** Runs when the answer went through, with what still waits. */
  onDone?: ((left: DecisionList) => void) | undefined;
}

/**
 * Answers a decision from Needs you, the bell or Home. A one-click answer to a question waits five
 * seconds with an Undo, like the room's question card; everything else is sent at once. A failure
 * says what failed ("Could not merge") and why.
 */
export function useSendDecision() {
  const answer = useAnswerDecision();
  const toast = useToast();
  const client = useQueryClient();

  const sendNow = useCallback(
    (decision: OwnerDecision, option: string, options: SendOptions = {}) => {
      const chosen = decision.options.find((o) => o.id === option);
      const label = chosen?.label ?? option;
      answer
        .mutateAsync({
          id: decision.id,
          option,
          ...(options.text === undefined ? {} : { text: options.text }),
        })
        .then(
          (left) => {
            toast(`${label}: ${rowTitle(decision)}`);
            options.onDone?.(left);
          },
          (error: unknown) =>
            toast(failureTitle(decision, label, chosen?.text === true), {
              detail: describeError(error),
              tone: "error",
            }),
        );
    },
    [answer, toast],
  );

  const send = useCallback(
    (decision: OwnerDecision, option: string, options: SendOptions = {}) => {
      const chosen = decision.options.find((o) => o.id === option);
      const holdable = decision.kind === "question" && chosen !== undefined && chosen.text !== true;
      if (!holdable) {
        sendNow(decision, option, options);
        return;
      }
      if (holds.has(decision.id)) return;
      // The server holds the answer for its Undo time and sends it, also when this tab is gone.
      const timer = window.setTimeout(() => {
        holds.delete(decision.id);
        changed();
        void client.invalidateQueries({ queryKey: queryKeys.decisions });
        void cmd("decisions.list", {}).then(
          (left) => options.onDone?.(left),
          () => undefined,
        );
      }, UNDO_MS + 400);
      holds.set(decision.id, { option, timer });
      changed();
      const drop = () => {
        const held = holds.get(decision.id);
        if (held !== undefined) window.clearTimeout(held.timer);
        holds.delete(decision.id);
        changed();
      };
      cmd(
        "decisions.answer",
        { id: decision.id, option, holdMs: UNDO_MS },
        { reason: "Owner answered a decision" },
      ).then(
        () => undefined,
        (error: unknown) => {
          drop();
          toast(failureTitle(decision, chosen.label, false), { detail: describeError(error), tone: "error" });
        },
      );
      toast(`Sending in 5 seconds: ${chosen.label}`, {
        ms: UNDO_MS,
        action: {
          label: "Undo",
          onClick: () => {
            drop();
            void cmd("answers.cancelHeld", { key: decision.id }, { reason: "Owner undid an answer" });
          },
        },
      });
    },
    [sendNow, toast, client],
  );

  return { send, busy: answer.isPending };
}
