import { z } from "zod";

/** Metadata shipped with the runtime package and published beside it. */
export const ReleasePackageSchema = z.object({
  version: z.string().regex(/^v\d+\.\d+\.\d+$/),
  commit: z.string().regex(/^[0-9a-f]{40,64}$/),
});
export type ReleasePackage = z.infer<typeof ReleasePackageSchema>;
