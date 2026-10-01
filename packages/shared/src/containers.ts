import { z } from "zod";

/**
 * Containers that majhi runs for agents (PRV-53): a preview of the task's own image and service
 * containers for tests. Agents never get the Docker socket; they ask through the `majhi-containers`
 * MCP tool for this short list of actions. Every value an agent sends is checked here first, then
 * once more by the argument builders (apps/server/src/containers/args.ts) before any docker call.
 *
 * This file imports only zod: settings.ts and processes.ts import it, and accounts.ts imports settings.ts.
 */

/** An image reference like `postgres:16-alpine`. Starts with a letter or digit, so it is never a flag. */
export const ImageRefSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/, "Use an image like postgres:16-alpine");

/**
 * The image as docker resolves it, for comparing: trimmed, and `name` equals `name:latest`.
 * Nothing else is folded, so `postgres:16` and `library/postgres:16` are different images.
 */
export function normalizeImage(image: string): string {
  const ref = image.trim();
  const last = ref.slice(ref.lastIndexOf("/") + 1);
  return last.includes(":") || last.includes("@") ? ref : `${ref}:latest`;
}

export function sameImage(a: string, b: string): boolean {
  return normalizeImage(a) === normalizeImage(b);
}

/** A service or volume name. Part of docker names and network aliases, so lowercase and short. */
export const ContainerNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,30}$/, "Use lowercase letters, digits and dashes, starting with a letter");

/**
 * An absolute path inside a container. Only letters, digits and `._/@+-`: a comma or a quote would
 * let the path add keys to a `--mount` value.
 */
export const ContainerPathSchema = z
  .string()
  .max(200)
  .regex(/^\/[A-Za-z0-9._/@+-]*$/, "Use an absolute path like /var/lib/data")
  .refine((path) => path !== "/" && !path.split("/").includes(".."), {
    message: "Use a folder inside the container, not / and no .. segment",
  });

/** Variable names and values for a container: `KEY=value` pairs. No NUL in a value. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const noNul = (value: string) => !value.includes("\u0000");

function envMap(maxValue: number, maxKeys: number) {
  return z
    .record(
      z.string().regex(ENV_NAME, "Use a variable name like POSTGRES_PASSWORD"),
      z.string().max(maxValue).refine(noNul, "No NUL character"),
    )
    .refine((map) => Object.keys(map).length <= maxKeys, { message: `At most ${maxKeys} variables` });
}

export const EnvMapSchema = envMap(4_000, 32);
export type EnvMap = z.infer<typeof EnvMapSchema>;

/** The container's own command and arguments, after the image. Docker does not parse them as flags. */
export const CommandArgsSchema = z
  .array(z.string().max(2_000).refine(noNul, "No NUL character"))
  .max(32, "At most 32 arguments");

/** A stage name of a multi-stage Dockerfile (`--target`). */
export const BuildTargetSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "Use a stage name like runtime");

/** Build arguments, `--build-arg NAME=value`. */
export const BuildArgsSchema = envMap(1_000, 32);

/** Memory for a container or the preview builder, like `512m` or `2g`. */
export const ContainerMemorySchema = z.string().regex(/^[1-9][0-9]{0,3}[mg]$/, "Use a size like 512m or 2g");

/** CPUs for a container or the preview builder. */
export const ContainerCpusSchema = z.number().min(0.25).max(16);

export const ContainerKindSchema = z.enum(["build", "preview", "service"]);
export type ContainerKind = z.infer<typeof ContainerKindSchema>;

/**
 * What a container process shows in the Processes card. `url` is what the task's runners use
 * (`http://majhi-preview-prv-53:7070`, or `db:5432` for a service started with `port`); `hostUrl`
 * is the owner's link (`http://127.0.0.1:49153`, previews only).
 */
export const ProcessContainerSchema = z.object({
  kind: ContainerKindSchema,
  name: z.string(),
  image: z.string(),
  url: z.string().optional(),
  hostUrl: z.string().optional(),
});
export type ProcessContainer = z.infer<typeof ProcessContainerSchema>;

/** One running preview or service, for lists (the Hub, `containers.list`, the tool's `list`). */
export const ContainerInfoSchema = z.object({
  task: z.string(),
  /** The container's process id in the task, like `p3`. */
  process: z.string(),
  /** The agent that started it. */
  agent: z.string(),
  kind: z.enum(["preview", "service"]),
  name: z.string(),
  image: z.string(),
  status: z.enum(["running", "exited", "stopped"]),
  url: z.string().optional(),
  hostUrl: z.string().optional(),
  startedAt: z.string(),
});
export type ContainerInfo = z.infer<typeof ContainerInfoSchema>;

// ---------------------------------------------------------------------------
// majhi-containers tool inputs

/** A task repo's folder name, like `api`. Default: the task's first repo. */
const RepoNameSchema = z.string().trim().min(1).max(100);

export const PreviewBuildInputSchema = z.object({
  repo: RepoNameSchema.optional().describe("A task repo's folder name, like api. Default: the first repo"),
  dockerfile: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .default("Dockerfile")
    .describe("Path of the Dockerfile, relative to the repo. Default: Dockerfile"),
  target: BuildTargetSchema.optional().describe("Stage of a multi-stage Dockerfile to build"),
  build_args: BuildArgsSchema.optional().describe("Build arguments, NAME to value"),
});
export type PreviewBuildInput = z.infer<typeof PreviewBuildInputSchema>;

export const PreviewRunInputSchema = z.object({
  port: z.number().int().min(1).max(65_535).describe("The port the app listens on inside the container"),
  env: EnvMapSchema.optional().describe("Environment variables for the app"),
  command: CommandArgsSchema.optional().describe("Command and arguments instead of the image's own"),
  scratch: ContainerPathSchema.default("/preview").describe(
    "A writable, throwaway folder in the container, removed with it. Default: /preview",
  ),
});
export type PreviewRunInput = z.infer<typeof PreviewRunInputSchema>;

export const PreviewStopInputSchema = z.object({});

export const ServiceVolumeSchema = z.object({
  name: ContainerNameSchema.describe("Volume name. It keeps its data while the task lives"),
  path: ContainerPathSchema.describe("Where the volume appears in the container"),
});
export type ServiceVolume = z.infer<typeof ServiceVolumeSchema>;

export const ServiceStartInputSchema = z.object({
  name: ContainerNameSchema.refine((name) => name !== "preview", {
    message: "preview is the name of the preview container",
  }).describe("Short name, also the host name in this task's network"),
  image: ImageRefSchema.describe("An image the owner allowed, like postgres:16-alpine"),
  port: z.number().int().min(1).max(65_535).optional().describe("The port the service listens on"),
  env: EnvMapSchema.optional().describe("Environment variables, like POSTGRES_PASSWORD"),
  command: CommandArgsSchema.optional().describe("Command and arguments instead of the image's own"),
  volumes: z.array(ServiceVolumeSchema).max(4).optional().describe("Named volumes, at most 4"),
});
export type ServiceStartInput = z.infer<typeof ServiceStartInputSchema>;

export const ServiceStopInputSchema = z.object({ name: ContainerNameSchema });

/** Service names, and `preview` for the preview. */

export const ContainerListInputSchema = z.object({});

export const ContainerLogsInputSchema = z.object({
  name: ContainerNameSchema.describe('"preview" or the name of a service'),
  lines: z.number().int().min(1).max(200).default(50).describe("How many of the last lines"),
});
