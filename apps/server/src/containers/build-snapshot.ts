import { type PrivateFile, writePrivateFile } from "./private-file.ts";

/**
 * The Dockerfile majhi checked, written to a folder of majhi's own so BuildKit reads those bytes and
 * not whatever the task's file holds a moment later. The folder is private to the build, outside every
 * task folder, and removed when the build ends.
 */
export type DockerfileSnapshot = PrivateFile;

export const snapshotDockerfile = (text: string): Promise<DockerfileSnapshot> =>
  writePrivateFile("majhi-build-", "Dockerfile", text);
