import { z } from "zod";

/** The owner's computer right now, as the host helper reads it (not the container's view). */
export const MachineHostSchema = z.object({
  cores: z.number().int().positive(),
  load1: z.number().nonnegative(),
  load5: z.number().nonnegative(),
  load15: z.number().nonnegative(),
  memTotalBytes: z.number().nonnegative(),
  /** Free plus what the system gives back at once (inactive, cached). */
  memAvailableBytes: z.number().nonnegative().optional(),
  /** macOS memory pressure: normal, warn or critical. Absent where the system does not say. */
  pressure: z.enum(["normal", "warn", "critical"]).optional(),
  /** Percent of CPU time idle over the last moment. Absent where it is not cheap to read. */
  idleCpuPct: z.number().min(0).max(100).optional(),
  diskFreeBytes: z.number().nonnegative().optional(),
});
export type MachineHost = z.infer<typeof MachineHostSchema>;

/** One of majhi's containers (`majhi-run-*`, `majhi-preview-*`), from `docker stats`. */
export const MachineContainerSchema = z.object({
  name: z.string(),
  cpuPct: z.number().nonnegative(),
  memBytes: z.number().nonnegative(),
});
export type MachineContainer = z.infer<typeof MachineContainerSchema>;

export const MachineReadingSchema = z.object({
  /** UTC ISO time of the poll. */
  at: z.string(),
  /** Absent while the host helper is not connected. */
  host: MachineHostSchema.optional(),
  containers: z.array(MachineContainerSchema),
});
export type MachineReading = z.infer<typeof MachineReadingSchema>;
