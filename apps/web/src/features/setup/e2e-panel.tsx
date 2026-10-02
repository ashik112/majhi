import type { E2eStatus } from "@majhi/shared";
import { DetailSection } from "@/components/ui/list-detail";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { useSaveSettings } from "@/lib/boss-queries";
import { useE2eStatus } from "@/lib/e2e-queries";
import { describeError } from "@/lib/errors";

type Project = E2eStatus["projects"][number];

/**
 * Background e2e: after a merge into a project's main branch, the host helper runs its Playwright
 * suite in its own worktree. The switch is per project. Off by default except for majhi itself.
 */
export function E2eSection({ saved }: { saved: Record<string, boolean> }) {
  const status = useE2eStatus();
  const save = useSaveSettings();
  const toast = useToast();
  const projects = status.data?.projects ?? [];

  function set(project: Project, on: boolean) {
    // Only the owner's own switches are written. A project left out uses the default.
    save.mutate(
      { e2e: { projects: { ...saved, [project.id]: on } } },
      { onError: (e) => toast("Could not save the switch", { detail: describeError(e), tone: "error" }) },
    );
  }

  return (
    <DetailSection
      title="Background e2e"
      note="Saved to majhi.yaml, as a change you can undo"
      className="border-t-0"
    >
      <div className="flex max-w-[640px] flex-col gap-3">
        <p className="text-base text-fg-soft">
          After each merge into a project's main branch, the host helper runs the whole Playwright suite on
          its own, one run at a time and at low priority. The result shows on Health and in the room of the
          task that merged. A failure opens one task with the traces. It never touches your checkout, majhi.db
          or port 7070.
        </p>
        {projects.length === 0 && <p className="text-base text-fg-faint">No projects are registered yet.</p>}
        {projects.map((project) => (
          <Switch
            key={project.id}
            label={project.byDefault && project.on ? `${project.id} (on by default)` : project.id}
            checked={project.on}
            disabled={save.isPending}
            onChange={(on) => set(project, on)}
          />
        ))}
      </div>
    </DetailSection>
  );
}
