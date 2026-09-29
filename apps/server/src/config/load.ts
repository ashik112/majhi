import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  ConfigPath,
  type ConfigState,
  DEFAULT_TASKS_DIR_NAME,
  expandHome,
  type MajhiConfig,
  MajhiConfigSchema,
  type ResolvedConfig,
} from "@majhi/shared";
import { parseDocument } from "yaml";
import { z } from "zod";
import { errorCode, errorMessage, formatIssues } from "../errors.ts";

export const CONFIG_FILE_NAME = "majhi.yaml";

export interface ConfigPaths {
  /** Folder holding majhi.yaml. */
  majhiHome: string;
  /** Owner's home on the host. `~` expands against it. */
  hostHome: string;
}

export interface LoadedConfig {
  state: ConfigState;
  /** Absolute paths of projects registered in majhi.yaml. Empty unless the config loaded. */
  projectPaths: string[];
}

export function configFilePath(majhiHome: string): string {
  return join(majhiHome, CONFIG_FILE_NAME);
}

/** Reads and validates majhi.yaml. Never throws: problems come back as an `invalid` state. */
export async function loadConfig(paths: ConfigPaths): Promise<LoadedConfig> {
  const file = configFilePath(paths.majhiHome);
  const base = { file, home: paths.hostHome };
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if (errorCode(err) === "ENOENT") return { state: { status: "first-run", ...base }, projectPaths: [] };
    return invalid(base, [`Cannot read ${file}: ${errorMessage(err)}`]);
  }
  return parseConfigText(text, paths.hostHome, file);
}

/** Parses the text of majhi.yaml. Split from `loadConfig` so it can run without a file. */
export function parseConfigText(text: string, hostHome: string, file: string): LoadedConfig {
  const base = { file, home: hostHome };
  const doc = parseDocument(text);
  if (doc.errors.length > 0) return invalid(base, doc.errors.map(yamlErrorLine));
  if (doc.contents === null) return invalid(base, ["The file is empty. Add at least one workspace root."]);

  const parsed = MajhiConfigSchema.safeParse(doc.toJS());
  if (!parsed.success) return invalid(base, formatIssues(parsed.error));

  return {
    state: { status: "loaded", ...base, config: resolveConfig(parsed.data, hostHome) },
    projectPaths: projectPaths(parsed.data, hostHome),
  };
}

/** Expands every path to an absolute one and fills in the default tasks folder. */
export function resolveConfig(config: MajhiConfig, hostHome: string): ResolvedConfig {
  const workspaces = [...new Set(config.workspaces.map((p) => resolvePath(p, hostHome)))];
  const first = workspaces[0];
  if (first === undefined) throw new Error("majhi.yaml has no workspace roots");
  const tasksDir =
    config.tasks_dir === undefined
      ? join(first, DEFAULT_TASKS_DIR_NAME)
      : resolvePath(config.tasks_dir, hostHome);
  return { workspaces, tasksDir };
}

export function resolvePath(path: string, hostHome: string): string {
  return resolve(expandHome(path, hostHome));
}

/** Projects are loosely typed until a later phase, so read `path` defensively and skip anything odd. */
const ProjectWithPath = z.looseObject({ path: ConfigPath });

function projectPaths(config: MajhiConfig, hostHome: string): string[] {
  const out: string[] = [];
  for (const project of Object.values(config.projects ?? {})) {
    const parsed = ProjectWithPath.safeParse(project);
    if (parsed.success) out.push(resolvePath(parsed.data.path, hostHome));
  }
  return out;
}

function invalid(base: { file: string; home: string }, errors: string[]): LoadedConfig {
  return { state: { status: "invalid", ...base, errors }, projectPaths: [] };
}

/** The yaml library puts a code frame after the first line. Keep only the first line. */
function yamlErrorLine(err: Error): string {
  const first = err.message.split("\n", 1)[0] ?? err.message;
  return first.replace(/:\s*$/, "");
}
