import {
  ConfigPath,
  collapseHome,
  DEFAULT_TASKS_DIR_NAME,
  expandHome,
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
  if (workspaces.length === 0 && rowErrors.size === 0) check.formError = "Add at least one workspace root";

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
