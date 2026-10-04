import type { DecisionList, OwnerDecision } from "@majhi/shared";
import { useCallback, useSyncExternalStore } from "react";
import { useToast } from "@/components/ui/toast";
import { useAnswerDecision } from "@/lib/decision-queries";
import { describeError } from "@/lib/errors";
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

/** "Could not merge", "Could not allow once": what failed, from the button's own words. */
export function failureTitle(label: string, typed: boolean): string {
  const words = label.trim().toLowerCase();
  return typed || words === "" || words.length > 40 ? "Could not answer it" : `Could not ${words}`;
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
            toast(failureTitle(label, chosen?.text === true), {
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
      const timer = window.setTimeout(() => {
        holds.delete(decision.id);
        changed();
        sendNow(decision, option, options);
      }, UNDO_MS);
      holds.set(decision.id, { option, timer });
      changed();
      toast(`Sending in 5 seconds: ${chosen.label}`, {
        ms: UNDO_MS,
        action: {
          label: "Undo",
          onClick: () => {
            const held = holds.get(decision.id);
            if (held !== undefined) window.clearTimeout(held.timer);
            holds.delete(decision.id);
            changed();
          },
        },
      });
    },
    [sendNow, toast],
  );

  return { send, busy: answer.isPending };
}
