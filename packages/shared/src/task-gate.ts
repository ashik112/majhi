import { z } from "zod";

/**
 * Who is making a task, for the task gate (docs/briefs/workflow-reset.md, Step 1). The one list:
 * every creator names one of these, and the server's `admit` decides from it.
 */
export const GateOriginSchema = z.enum([
  "owner",
  "captain",
  "agent",
  "incident",
  "client-chat",
  "schedule",
  "finding",
]);
export type GateOrigin = z.infer<typeof GateOriginSchema>;
