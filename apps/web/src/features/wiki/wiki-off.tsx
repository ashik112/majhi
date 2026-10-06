import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { describeError } from "@/lib/errors";
import { GLASS } from "@/lib/glass";
import { useUpdateOrg } from "@/lib/studio-queries";
import type { WikiWorkspace } from "./use-wiki-switch";

/** The page of a workspace whose wiki is off: what off means, and one click to turn it on for this workspace. */
export function WikiOff({ workspace }: { workspace: WikiWorkspace }) {
  const update = useUpdateOrg();
  const toast = useToast();
  const name = workspace.org.name;
  return (
    <div className={cn("flex min-h-0 flex-1 items-center justify-center rounded-2xl p-8", GLASS)}>
      <div className="flex max-w-[460px] flex-col items-center gap-2 text-center">
        <h2 className="text-md font-semibold text-fg">Wiki is off for {name}</h2>
        <p className="text-base text-fg-muted text-pretty">
          Nothing runs, agents get no wiki tool and tasks get no wiki section. Turn it on to build
          architecture pages for each project.
        </p>
        <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
          <Button
            variant="primary"
            disabled={update.isPending}
            onClick={() =>
              update.mutate(
                { id: workspace.org.id, wiki: { enabled: true } },
                {
                  onError: (e) => toast("Could not turn it on", { detail: describeError(e), tone: "error" }),
                },
              )
            }
          >
            Turn on for {name}
          </Button>
          <Button asChild>
            <Link to="/setup" search={{ section: "wiki" }}>
              Open settings
            </Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
