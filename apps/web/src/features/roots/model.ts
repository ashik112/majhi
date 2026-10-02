import {
  ConfigPath,
  collapseHome,
  DEFAULT_TASKS_DIR_NAME,
  expandHome,
  type ProtectedFolder,
  protectedFolder,
  type ResolvedConfig,
  type WorkspacesUpdate,
} from "@majhi/shared";

export interface RootRow {
  id: number;
  value: string;
}

export interface RootsDraft {
  rows: RootRow[];
  tasksDir: string;
}

export interface RootsCheck {
  /** Error per row id. */
  rowErrors: Map<number, string>;
  tasksDirError?: string;
  /** Problem with the form as a whole, like no roots at all. */
  formError?: string;
  /** The command input, present only when there are no errors. */
  input?: WorkspacesUpdate;
}

/**
 * Checks a draft the same way the server will (`ConfigPath`), and also rejects a root listed
 * twice, comparing paths after `~` is expanded. Blank rows are ignored.
 */
export function checkRoots(draft: RootsDraft, home: string): RootsCheck {
  const rowErrors = new Map<number, string>();
  const seen = new Set<string>();
  const workspaces: string[] = [];

  for (const row of draft.rows) {
    const value = row.value.trim();
    if (value === "") continue;
    const parsed = ConfigPath.safeParse(value);
    if (!parsed.success) {
      rowErrors.set(row.id, parsed.error.issues[0]?.message ?? "Invalid path");
      continue;
    }
    const absolute = expandHome(parsed.data, home);
    if (seen.has(absolute)) {
      rowErrors.set(row.id, "Already listed above");
      continue;
    }
    seen.add(absolute);
    workspaces.push(parsed.data);
  }

  const check: RootsCheck = { rowErrors };
  if (workspaces.length === 0 && rowErrors.size === 0) check.formError = "Add at least one project folder";

  const tasksDir = draft.tasksDir.trim();
  let tasksDirValue: string | undefined;
  if (tasksDir !== "") {
    const parsed = ConfigPath.safeParse(tasksDir);
    if (parsed.success) tasksDirValue = parsed.data;
    else check.tasksDirError = parsed.error.issues[0]?.message ?? "Invalid path";
  }

  if (rowErrors.size === 0 && !check.formError && !check.tasksDirError) {
    check.input = tasksDirValue === undefined ? { workspaces } : { workspaces, tasks_dir: tasksDirValue };
  }
  return check;
}

/** Where tasks go when no tasks folder is set: `<first root>/.majhi`. */
export function defaultTasksDir(firstRoot: string): string {
  const root = firstRoot.trim().replace(/\/+$/, "");
  return `${root === "" ? "~/Work" : root}/${DEFAULT_TASKS_DIR_NAME}`;
}

/**
 * Turns the loaded config back into a draft, with `~` for the home folder. The tasks folder
 * stays blank when it is the default, so saving does not pin it.
 */
export function draftFromConfig(config: ResolvedConfig, home: string): RootsDraft {
  const rows = config.workspaces.map((path, id) => ({ id, value: collapseHome(path, home) }));
  const first = config.workspaces[0];
  const isDefault = first !== undefined && config.tasksDir === defaultTasksDir(first);
  return { rows, tasksDir: isDefault ? "" : collapseHome(config.tasksDir, home) };
}

/** Absolute paths of the roots in a draft, for marking folders that are already roots. */
export function chosenPaths(rows: readonly RootRow[], home: string): Set<string> {
  const paths = new Set<string>();
  for (const row of rows) if (row.value.trim() !== "") paths.add(expandHome(row.value, home));
  return paths;
}

/**
 * Checks one typed root before it joins the list, with the same rules as `checkRoots`.
 * Returns the value to store, or the error to show under the field.
 */
export function checkNewRoot(
  value: string,
  rows: readonly RootRow[],
  home: string,
): { value: string } | { error: string } {
  const parsed = ConfigPath.safeParse(value);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid path" };
  if (chosenPaths(rows, home).has(expandHome(parsed.data, home))) return { error: "Already added" };
  return { value: parsed.data };
}

export interface Crumb {
  label: string;
  path: string;
}

/**
 * Splits an absolute path into clickable steps. Paths under home start at `~`, others at `/`:
 * `/home/me/Work/ops` gives `~`, `Work`, `ops`.
 */
export function breadcrumbs(path: string, home: string): Crumb[] {
  const base = home.replace(/\/+$/, "");
  const underHome = path === base || path.startsWith(`${base}/`);
  const crumbs: Crumb[] = [underHome ? { label: "~", path: base } : { label: "/", path: "/" }];
  let current = underHome ? base : "";
  const rest = underHome ? path.slice(base.length) : path;
  for (const name of rest.split("/")) {
    if (name === "") continue;
    current = `${current}/${name}`;
    crumbs.push({ label: name, path: current });
  }
  return crumbs;
}

/** The folder above an absolute path, or null at `/`. */
export function parentPath(path: string): string | null {
  const trimmed = path.replace(/\/+$/, "");
  if (trimmed === "") return null;
  const cut = trimmed.lastIndexOf("/");
  return cut <= 0 ? "/" : trimmed.slice(0, cut);
}

export interface ProtectedRoot {
  /** As the owner sees it, like `~/Documents/code`. */
  path: string;
  folder: ProtectedFolder;
}

/** The chosen roots, and the tasks folder, that sit in a folder macOS protects. Each shows once. */
export function protectedRoots(rows: readonly RootRow[], tasksDir: string, home: string): ProtectedRoot[] {
  const seen = new Set<string>();
  const found: ProtectedRoot[] = [];
  for (const value of [...rows.map((r) => r.value), tasksDir]) {
    const trimmed = value.trim();
    if (trimmed === "" || seen.has(trimmed)) continue;
    seen.add(trimmed);
    const folder = protectedFolder(trimmed, home);
    if (folder !== undefined) found.push({ path: collapseHome(expandHome(trimmed, home), home), folder });
  }
  return found;
}

/** The warning under the picker. `runtime` is what the host helper found, like "OrbStack". */
export function protectedWarning(found: readonly ProtectedRoot[], runtime: string): string {
  const folders = [...new Set(found.map((f) => f.folder))];
  const what = folders.length === 1 ? `your ${folders[0]} folder` : `these folders (${folders.join(", ")})`;
  return `macOS will ask whether ${runtime} may access ${what}. Click Allow when it asks, or majhi cannot see it.`;
}
