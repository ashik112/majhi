import type { RepoCommit } from "@majhi/shared";
import { plural } from "@/lib/format";

/** The branch's commits, newest first, each with the agent that made it. */
export function CommitList({ commits, limit }: { commits: readonly RepoCommit[]; limit?: number }) {
  if (commits.length === 0) return null;
  const shown = limit === undefined ? commits : commits.slice(0, limit);
  const hidden = commits.length - shown.length;
  return (
    <div className="flex flex-col gap-0.5">
      <ul aria-label="Commits" className="flex flex-col gap-0.5">
        {shown.map((commit) => (
          <li key={commit.sha} className="flex items-baseline gap-2 text-xs">
            <span className="shrink-0 font-mono text-fg-faint">{commit.sha.slice(0, 7)}</span>
            <span className="min-w-0 truncate text-fg-soft" title={commit.subject}>
              {commit.subject}
            </span>
            {commit.agent !== undefined && (
              <span className="ml-auto shrink-0 font-mono text-fg-muted">@{commit.agent}</span>
            )}
          </li>
        ))}
      </ul>
      {hidden > 0 && <p className="text-xs text-fg-faint">and {plural(hidden, "more commit")}</p>}
    </div>
  );
}
