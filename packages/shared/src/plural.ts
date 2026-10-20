/** "1 repo", "3 repos": the one place a count is joined to its noun. */
export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
