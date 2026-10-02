/** The sections of Hub setup, in list order, under their group. The URL keeps one as `?section=`. */
export const SETUP_GROUPS = [
  { label: "Setup", sections: ["overview", "roots", "ssh"] },
  {
    label: "How majhi works",
    sections: ["decisions", "memory", "context", "teams", "approvals", "notifications", "containers"],
  },
  { label: "More", sections: ["editor", "appearance", "backups", "history"] },
] as const;

export type SetupSection = (typeof SETUP_GROUPS)[number]["sections"][number];

export const SETUP_SECTIONS: readonly SetupSection[] = SETUP_GROUPS.flatMap((g) => g.sections);

export const SECTION_TITLE: Record<SetupSection, string> = {
  overview: "Overview",
  roots: "Workspace roots",
  ssh: "SSH keys",
  decisions: "Decisions",
  memory: "Memory",
  context: "Context and limits",
  teams: "Teams",
  approvals: "Approvals",
  notifications: "Notifications",
  editor: "Editor",
  containers: "Containers",
  appearance: "Appearance",
  backups: "Backups",
  history: "History",
};

/** One line under the title in the detail head. */
export const SECTION_ABOUT: Record<SetupSection, string> = {
  overview: "What majhi needs before agents can work, and the one step each part may still need.",
  roots: "The folders majhi scans for git repos. It can only see folders that are mounted.",
  ssh: "The keys majhi's git uses to reach your hosts. Passphrases stay in the macOS Keychain.",
  decisions: "Who answers the small typed questions agents ask, like which model fits a task.",
  memory: "Who writes each finished task's record, the project briefs and lessons, and how lessons are kept.",
  context: "When agent context is compacted, how many agents run at once, and resuming cut-off runs.",
  teams: "How long agents in a room may pass work around without you.",
  approvals: "What agents may do without asking you, and what they asked for lately.",
  notifications:
    "A Mac banner and a browser notification when an agent needs you: approvals, questions, stops.",
  editor: "Which editor opens files, worktrees and projects: VS Code or Cursor.",
  containers: "Previews and test services majhi runs for agents, the images they may use, and their limits.",
  appearance: "Theme and accent. Saved in this browser only.",
  backups: "A daily snapshot of majhi.db (tasks, rooms, history), kept 7 days, and restore.",
  history: "Every change to majhi.yaml, by you, the boss or a hand edit.",
};

export function isSetupSection(value: string | undefined): value is SetupSection {
  return SETUP_SECTIONS.some((s) => s === value);
}
