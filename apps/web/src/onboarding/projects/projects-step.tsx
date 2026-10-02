import { useState } from "react";
import { Segmented } from "@/components/ui/segmented";
import { StepFrame } from "../step-frame";
import { LocalRepos } from "./local-repos";
import { NewProject } from "./new-project";
import { RemoteRepos } from "./remote-repos";

export type ProjectsWay = "local" | "remote" | "new";

/**
 * Projects, three ways on one screen: repos already on this computer, repos on a git host the
 * workspace signed in to (cloned with live progress), or a new empty project.
 */
export function ProjectsStep() {
  const [way, setWay] = useState<ProjectsWay>("local");
  return (
    <StepFrame>
      <div className="flex flex-col gap-6">
        <Segmented<ProjectsWay>
          label="Where the projects come from"
          value={way}
          onChange={setWay}
          className="self-start"
          segments={[
            { value: "local", label: "On this computer" },
            { value: "remote", label: "From GitHub, GitLab or Bitbucket" },
            { value: "new", label: "New project" },
          ]}
        />
        {way === "local" && <LocalRepos onWay={setWay} />}
        {way === "remote" && <RemoteRepos onWay={setWay} />}
        {way === "new" && <NewProject />}
      </div>
    </StepFrame>
  );
}
