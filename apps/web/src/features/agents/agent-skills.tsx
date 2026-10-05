import { type AgentFrontmatter, type Skill, type SkillVia, skillStateFor } from "@majhi/shared";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { DetailSection } from "@/components/ui/list-detail";
import { PageLink } from "@/components/ui/page-link";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { describeError } from "@/lib/errors";
import { useSkills, useSkillsCommand } from "@/lib/skills-queries";

/** Past this many skills the list gets a search box. */
const SEARCH_FROM = 10;

const VIA_HINT: Record<SkillVia, string> = {
  agent: "",
  workspace: "via workspace",
  all: "via all agents",
};

/**
 * The installed skills and whether this agent has each. The rules live in the skills lock, the same
 * ones the Skills page edits: a switch here sets this agent's own choice, which beats its
 * workspace's rule and the all-agents rule. Each switch saves at once.
 */
export function AgentSkills({ agent }: { agent: Pick<AgentFrontmatter, "id" | "scope"> }) {
  const skills = useSkills();
  const setMany = useSkillsCommand("skills.setMany");
  const toast = useToast();
  const [query, setQuery] = useState("");
  const installed = skills.data ?? [];
  const needle = query.trim().toLowerCase();
  const shown = needle === "" ? installed : installed.filter((s) => s.name.toLowerCase().includes(needle));
  const toggle = (skill: Skill, on: boolean) =>
    setMany.mutate(
      { skills: [skill.name], target: { kind: "agents", agents: [agent.id] }, on },
      {
        onError: (error) =>
          toast(`Could not change ${skill.name}`, { detail: describeError(error), tone: "error" }),
      },
    );
  return (
    <DetailSection
      title="Skills"
      note="Skills it may use in its next run, as read-only copies. Same switches as on the Skills page."
    >
      {skills.isError ? (
        <p role="alert" className="text-sm text-red text-pretty">
          Could not load skills: {describeError(skills.error)}
        </p>
      ) : installed.length === 0 && skills.data !== undefined ? (
        <p className="text-sm text-fg-muted text-pretty">
          No skills are installed yet.{" "}
          <PageLink page="skills" className="text-fg underline-offset-2 hover:underline">
            Install one
          </PageLink>
          .
        </p>
      ) : (
        <>
          {installed.length > SEARCH_FROM && (
            <Input
              aria-label="Search skills"
              placeholder="Search skills"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          )}
          <ul aria-label="Skills" className="flex flex-col gap-0.5">
            {shown.map((skill) => {
              const state = skillStateFor(skill, agent);
              return (
                <li key={skill.name} className="flex min-w-0 items-center gap-3">
                  <Switch
                    label={skill.name}
                    checked={state.on}
                    disabled={setMany.isPending}
                    onChange={(on) => toggle(skill, on)}
                  />
                  <span title={skill.description} className="min-w-0 flex-1 truncate text-sm text-fg-faint">
                    {skill.description}
                  </span>
                  {state.via !== "agent" && state.on && (
                    <span className="shrink-0 text-xs text-fg-faint">{VIA_HINT[state.via]}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </DetailSection>
  );
}
