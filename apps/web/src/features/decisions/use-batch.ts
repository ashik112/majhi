import { type BatchIntent, batchPlan, type DecisionBatchResult, type OwnerDecision } from "@majhi/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { cmd } from "@/lib/api";
import { useAfterBatch } from "@/lib/decision-queries";
import { describeError } from "@/lib/errors";
import { rangeIds } from "./model";

/** How long Approve and Leave wait before they are sent, so the owner can take them back. */
export const UNDO_SECONDS = 10;

export interface Hold {
  key: string;
  intent: BatchIntent;
  ids: string[];
  /** When it is sent (ms). */
  at: number;
}

/**
 * Batch selection and sending for the Decisions queue. Checking rows (click, shift-click for a range,
 * `x` and shift+`x` on the keyboard) builds a selection; Approve or Leave holds it for ten seconds, then
 * sends it as one `decisions.answerBatch` with a key, so a second send changes nothing. Leaving the page
 * sends what is held at once rather than dropping it.
 */
export function useBatch(queue: readonly OwnerDecision[]) {
  const after = useAfterBatch();
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [hold, setHold] = useState<Hold | undefined>();
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<DecisionBatchResult | undefined>();
  const [failure, setFailure] = useState<string | undefined>();
  const anchor = useRef<string | undefined>(undefined);
  const timer = useRef<number | undefined>(undefined);
  const holdRef = useRef<Hold | undefined>(undefined);
  holdRef.current = hold;

  const ids = useMemo(() => queue.map((d) => d.id), [queue]);
  // What was answered elsewhere leaves the selection.
  useEffect(() => {
    const here = new Set(ids);
    setPicked((prev) =>
      prev.size === 0 || [...prev].every((id) => here.has(id))
        ? prev
        : new Set([...prev].filter((id) => here.has(id))),
    );
  }, [ids]);

  const send = async (h: Hold) => {
    window.clearTimeout(timer.current);
    setHold(undefined);
    setSending(true);
    setFailure(undefined);
    try {
      const out = await cmd(
        "decisions.answerBatch",
        { batch: h.key, intent: h.intent, ids: h.ids },
        { reason: "Owner answered decisions in a batch" },
      );
      await after(out);
      setResult(out);
    } catch (error) {
      setFailure(describeError(error));
    } finally {
      setSending(false);
    }
  };
  const sendRef = useRef(send);
  sendRef.current = send;

  // The page closes while a batch waits: send it, the owner asked for it.
  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
      const h = holdRef.current;
      if (h !== undefined) void sendRef.current(h);
    },
    [],
  );

  const heldIds = useMemo(() => new Set(hold?.ids ?? []), [hold]);

  const toggle = (id: string, range: boolean) => {
    if (heldIds.has(id)) return;
    setPicked((prev) => {
      const next = new Set(prev);
      if (range && anchor.current !== undefined) {
        for (const r of rangeIds(ids, anchor.current, id)) if (!heldIds.has(r)) next.add(r);
      } else if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    if (!range) anchor.current = id;
  };

  return {
    picked,
    held: heldIds,
    hold,
    sending,
    result,
    failure,
    toggle,
    selectAll: () => setPicked(new Set(ids.filter((id) => !heldIds.has(id)))),
    select: (list: readonly string[]) => setPicked(new Set(list.filter((id) => !heldIds.has(id)))),
    clear: () => {
      setPicked(new Set());
      anchor.current = undefined;
    },
    /** Holds the batch for the undo time, then sends it. */
    start: (intent: BatchIntent, list: readonly string[]) => {
      if (list.length === 0 || holdRef.current !== undefined) return;
      const next: Hold = {
        key: crypto.randomUUID(),
        intent,
        ids: [...list],
        at: Date.now() + UNDO_SECONDS * 1000,
      };
      setHold(next);
      setResult(undefined);
      setFailure(undefined);
      setPicked(new Set());
      anchor.current = undefined;
      timer.current = window.setTimeout(() => void sendRef.current(next), UNDO_SECONDS * 1000);
    },
    undo: () => {
      window.clearTimeout(timer.current);
      setHold(undefined);
    },
    now: () => {
      const h = holdRef.current;
      if (h !== undefined) void sendRef.current(h);
    },
    dismiss: () => {
      setResult(undefined);
      setFailure(undefined);
    },
    plan: (intent: BatchIntent, list: readonly OwnerDecision[]) => batchPlan(list, intent),
  };
}
