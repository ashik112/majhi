import { collapseHome, type ProjectView, type Repo } from "@majhi/shared";
import { Copy, GitBranch } from "lucide-react";
import type { ReactNode } from "react";
import { HostGlyph } from "@/components/host-glyph";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { HOST_LABEL } from "@/lib/hosts";
import { useCopy } from "@/lib/use-copy";

/** The selected repo in full: path, branch, every remote, and whether a project points at it. */
export function RepoDetails({
  repo,
  home,
  onCopyPath,
  project,
}: {
  repo: Repo | undefined;
  home: string;
  onCopyPath: () => void;
  project?: ProjectView | undefined;
}) {
  const copy = useCopy();
  return (
    <aside
      aria-label="Repo details"
      className="hidden w-[22rem] shrink-0 flex-col border-l border-line bg-rail xl:flex"
    >
      {repo ? (
        <>
          <div className="flex items-center gap-2 border-b border-line px-5 py-3.5">
            <h2 className="min-w-0 truncate text-md font-semibold">{repo.name}</h2>
            {repo.registered && <Badge tone="green">registered</Badge>}
          </div>
          <dl className="flex min-h-0 flex-1 flex-col gap-5 overflow-auto px-5 py-4">
            <Field label="Path">
              <span className="font-mono text-sm break-all text-fg-soft">
                {collapseHome(repo.path, home)}
              </span>
            </Field>
            <Field label="Branch">
              <span className="flex items-center gap-1.5">
                <GitBranch aria-hidden="true" className="size-3 shrink-0 text-fg-faint" />
                {repo.branch ? (
                  <span className="font-mono text-sm break-all text-fg-soft">{repo.branch}</span>
                ) : (
                  <span className="text-sm text-fg-faint">Detached HEAD</span>
                )}
              </span>
            </Field>
            <Field label={repo.remotes.length > 1 ? `Remotes (${repo.remotes.length})` : "Remote"}>
              {repo.remotes.length === 0 ? (
                <span className="text-sm text-fg-faint">None. This repo is local only.</span>
              ) : (
                <ul className="flex flex-col gap-2">
                  {repo.remotes.map((remote) => (
                    <li
                      key={remote.name}
                      className="flex flex-col gap-1 rounded-md border border-line-strong bg-card px-2.5 py-2"
                    >
                      <span className="flex items-center gap-1.5">
                        <HostGlyph host={remote.host} />
                        <span className="text-sm text-fg">{HOST_LABEL[remote.host]}</span>
                        <span className="font-mono text-xs text-fg-faint">{remote.name}</span>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="-my-1 ml-auto -mr-1"
                          aria-label={`Copy ${remote.name} URL`}
                          title="Copy URL"
                          onClick={() => void copy(remote.url)}
                        >
                          <Copy aria-hidden="true" />
                        </Button>
                      </span>
                      <span className="font-mono text-xs break-all text-fg-muted">{remote.url}</span>
                      {remote.sshAlias && (
                        <span className="text-xs text-fg-faint">
                          Through SSH alias <span className="font-mono text-fg-muted">{remote.sshAlias}</span>
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Field>
            <Field label="Project">
              <span className="text-sm text-fg-soft">
                {project ? (
                  <>
                    <span className="font-mono">{project.id}</span> in {project.org}
                    {project.aliases.length > 0 && `, also called ${project.aliases.join(", ")}`}
                  </>
                ) : repo.registered ? (
                  "Registered in majhi.yaml"
                ) : (
                  "Not registered. Register it to use it in tasks."
                )}
              </span>
            </Field>
          </dl>
          <div className="border-t border-line p-3">
            <Button variant="secondary" className="w-full" onClick={onCopyPath}>
              <Copy aria-hidden="true" />
              Copy path
              <Kbd className="ml-1">Enter</Kbd>
            </Button>
          </div>
        </>
      ) : (
        <p className="px-5 py-4 text-sm text-fg-faint">Select a repo to see its path and remotes.</p>
      )}
    </aside>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <dt className="text-xs text-fg-faint">{label}</dt>
      <dd className="m-0">{children}</dd>
    </div>
  );
}
