import { z } from "zod";

export const MrStateSchema = z.enum(["open", "merged", "closed"]);
export type MrState = z.infer<typeof MrStateSchema>;

/** `none`: the host reports no checks, which is not the same as passing (5.5). */
export const CiStateSchema = z.enum(["none", "pending", "passing", "failing"]);
export type CiState = z.infer<typeof CiStateSchema>;
