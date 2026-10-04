import { errorMessage } from "../errors.ts";

/** Rows already reported, so a bad row is logged once per process and not on every read. */
const reported = new Set<string>();

/** Says once that a stored row could not be read and is left out. */
export function reportBadRow(table: string, key: string | number, err: unknown): void {
  const id = `${table}:${key}`;
  if (reported.has(id)) return;
  reported.add(id);
  console.error(`${table} row ${key} cannot be read and is skipped: ${errorMessage(err)}`);
}

/**
 * Parses stored rows one by one. A row that throws is skipped and logged once: one bad row (a source
 * or status a newer or older build did not know, a damaged column) must never fail the whole read.
 */
export function parseRows<R, T>(
  table: string,
  rows: readonly R[],
  keyOf: (row: R) => string | number,
  parse: (row: R) => T,
): T[] {
  const out: T[] = [];
  for (const row of rows) {
    try {
      out.push(parse(row));
    } catch (err) {
      reportBadRow(table, keyOf(row), err);
    }
  }
  return out;
}

/** Test hook: forgets which rows were reported. */
export function resetReportedRows(): void {
  reported.clear();
}
