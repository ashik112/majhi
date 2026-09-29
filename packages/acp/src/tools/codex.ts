import type { ToolDef } from "./types.ts";

export const codex: ToolDef = {
  info: {
    id: "codex",
    name: "Codex",
    authModes: ["login", "api-key"],
    loginHint: "Open the link, enter the code shown here, then press Enter.",
    apiKeyLabel: "OpenAI API key",
  },
  configHomeVar: "CODEX_HOME",
  apiKeyVar: "CODEX_API_KEY",
  adapter: { command: "codex-acp", args: [] },
  versionArgs: ["cli", "--version"],
  authStatusArgs: ["cli", "login", "status"],
  loginArgs: ["cli", "login", "--device-auth"],
  // Without this the adapter answers authRequired instead of using the key.
  apiKeyEnv: { DEFAULT_AUTH_REQUEST: JSON.stringify({ methodId: "api-key" }) },
  parseAuthStatus(exitCode) {
    return { signedIn: exitCode === 0 };
  },
};
