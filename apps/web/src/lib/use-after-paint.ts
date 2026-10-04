import { useIsFetching } from "@tanstack/react-query";
import { useEffect, useState } from "react";

/** The page asks for its own data in the first moments; nothing else is asked before this. */
const SETTLE_MS = 400;

/**
 * False until the page in front of the owner has its data (nothing is loading, at least 400 ms after
 * the first render), or until `maxMs` at the latest; then true for good. The sidebar's small readouts
 * (the Setup dot, the Update row) use it to ask the server after the page has its own answers, because the
 * server answers one request at a time and these are the slow ones (the doctor checks, every pending lesson).
 */
export function useAfterFirstPaint(maxMs: number): boolean {
  const loading = useIsFetching();
  const [settled, setSettled] = useState(false);
  const [late, setLate] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(true), SETTLE_MS);
    const cap = window.setTimeout(() => setLate(true), maxMs);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(cap);
    };
  }, [maxMs]);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (late || (settled && loading === 0)) setReady(true);
  }, [late, settled, loading]);
  return ready;
}
