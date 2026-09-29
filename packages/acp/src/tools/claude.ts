import { z } from "zod";
import type { ToolDef } from "./types.ts";

const AuthStatusJson = z.looseObject({
  loggedIn: z.boolean().optional(),
  email: z.string().optional(),
  orgName: z.string().optional(),
  subscriptionType: z.string().optional(),
  apiKeySource: z.string().optional(),
});

export const claude: ToolDef = {
  info: {
    id: "claude",
    name: "Claude Code",
    authModes: ["login", "api-key"],
    loginHint: "Open the link, sign in to Claude, then paste the code back here.",
    apiKeyLabel: "Anthropic API key",
  },
  configHomeVar: "CLAUDE_CONFIG_DIR",
  apiKeyVar: "ANTHROPIC_API_KEY",
  adapter: { command: "claude-agent-acp", args: [] },
  versionArgs: ["--cli", "--version"],
  authStatusArgs: ["--cli", "auth", "status", "--json"],
  loginArgs: ["--cli", "auth", "login", "--claudeai"],
  parseAuthStatus(exitCode, stdout) {
    if (exitCode !== 0) return { signedIn: false };
    try {
      const parsed = AuthStatusJson.safeParse(JSON.parse(stdout));
      if (parsed.success) {
        if (parsed.data.loggedIn === false) return { signedIn: false };
        const as = parsed.data.email ?? parsed.data.orgName;
        return as ? { signedIn: true, as } : { signedIn: true };
      }
    } catch {
      // Exit 0 already says signed in; the JSON only adds the email.
    }
    return { signedIn: true };
  },
};
