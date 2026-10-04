import { useEffect, useState } from "react";

/**
 * False until `ms` after the first render, then true. The sidebar's small readouts (the Setup dot, the
 * Update row) use it to ask the server after the page in front of the owner has its own data, because the
 * server answers one request at a time and these are the slow ones (the doctor checks, every pending lesson).
 */
export function useAfterFirstPaint(ms: number): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setReady(true), ms);
    return () => window.clearTimeout(timer);
  }, [ms]);
  return ready;
}
