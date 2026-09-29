import { Sparkles } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";

/**
 * Skills arrive in Phase 6. Until then this is the page as it will look, with the install field off
 * and no rows, so nothing on it pretends to work.
 */
export function SkillsView() {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <PageHeader
        title="Skills"
        subtitle="Folders with a SKILL.md in ~/.majhi/skills. Every runtime can use them. Install here, or just send a link to any agent in a room."
      />
      <div className="flex flex-col gap-[18px] px-8 pt-5 pb-7">
        <div className="flex gap-2.5">
          <label htmlFor="skill-source" className="sr-only">
            Skill link or folder path
          </label>
          <input
            id="skill-source"
            disabled
            placeholder="GitHub link, zip, or a local folder like ~/Downloads/my-skill"
            className="h-11 min-w-0 flex-1 cursor-not-allowed rounded-[10px] border border-line-bright bg-raised px-3.5 text-[0.875rem] text-fg opacity-55"
          />
          <button
            type="button"
            disabled
            className="h-11 cursor-not-allowed rounded-[10px] bg-amber px-[18px] text-[0.875rem] font-semibold text-amber-ink opacity-45"
          >
            Install
          </button>
        </div>
        <div className="flex max-w-[640px] items-start gap-3 rounded-xl border border-dashed border-line-hover px-4 py-3.5">
          <Sparkles aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-fg-faint" />
          <p className="text-base text-fg-muted text-pretty">
            Skills arrive in Phase 6. Then you can install one here from a GitHub link, a zip or a folder, and
            choose which agents use it.
          </p>
        </div>
      </div>
    </div>
  );
}
