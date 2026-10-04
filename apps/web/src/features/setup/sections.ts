import type { SetupSection } from "@majhi/shared";

/** One line under the title in the detail head. */
export const SECTION_ABOUT: Record<SetupSection, string> = {
  overview: "What majhi needs before agents can work, and the one step each part may still need.",
  roots: "The folders majhi scans for git repos. It can only see folders that are mounted.",
  ssh: "The keys majhi's git uses to reach your hosts. Passphrases stay on this computer.",
  decisions: "The small local model that makes cheap, frequent calls, and how well each one is doing.",
  memory: "Who writes each finished task's record, the project briefs and lessons, and how lessons are kept.",
  context: "When agent context is compacted, how many agents run at once, and resuming cut-off runs.",
  turns: "How long one agent turn may run, stay idle or call tools before it continues in a fresh session.",
  teams: "How long agents in a room may pass work around without you.",
  approvals: "What agents may do without asking you, and what they asked for lately.",
  notifications:
    "A desktop banner and a browser notification when an agent needs you: approvals, questions, stops.",
  editor: "Which editor opens files, worktrees and projects: VS Code or Cursor.",
  e2e: "When the full e2e suite runs on this computer: off, after each merge into main, or daily.",
  containers: "Previews and test services majhi runs for agents, the images they may use, and their limits.",
  appearance: "Theme and accent. Saved in this browser only.",
  backups: "Encrypted backups of your data: daily, before updates, tested weekly, with restore.",
  history: "Every change to majhi.yaml, by you, the captain or a hand edit.",
};
