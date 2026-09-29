import type { GitHost } from "@majhi/shared";

export const HOST_LABEL: Record<GitHost, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  bitbucket: "Bitbucket",
  other: "Other host",
};
