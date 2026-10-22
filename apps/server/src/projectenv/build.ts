import { posix } from "node:path";
import { quoteWord } from "../ci/shell.ts";
import type { PythonPlan } from "./python.ts";
import { isDebianPackage } from "./system-needs.ts";

/**
 * The steps that make a Python environment, as one shell script for the runner (`ExecFn` of the hand-off
 * checks runs it, so it has the runner's limits, network guard and the workspace's package store). Every
 * value in it is a path majhi made or a name checked here; nothing a repo wrote reaches the shell: the
 * requirements go in files, which `uv` reads. `step` lines (`==> text`) tell where a failure was.
 *
 * Layout of an environment folder (`<majhi home>/envs/<org>/<project>/<key>`): `venv`, `inputs` (the
 * flattened requirements), `sysroot` (system packages fetched without root: `apt-get --download-only` into a
 * folder, then `dpkg-deb -x`), `apt` (its lists and archives), `python` (a Python `uv` fetched, if the project
 * asks for one the runner has not) and `ready.json`, written last.
 */

export const STEP = "==> ";
/** What the last line of a build's output says when it worked: the Python the venv has. */
export const PYTHON_LINE = "majhi-python ";

/** A name that can sit on a command line unquoted: letters, digits and `. _ -`. */
const isWord = (text: string): boolean =>
  text.length > 0 &&
  text.length <= 64 &&
  [...text].every(
    (c) =>
      (c >= "a" && c <= "z") ||
      (c >= "A" && c <= "Z") ||
      (c >= "0" && c <= "9") ||
      c === "." ||
      c === "_" ||
      c === "-",
  );

/** The files of `inputs/` the plan needs, by name. */
export function inputFiles(plan: PythonPlan): Record<string, string> {
  const out: Record<string, string> = {};
  for (const install of plan.installs) {
    if (install.kind !== "pip") continue;
    out["requirements.txt"] = install.requirements;
    if (install.constraints !== "") out["constraints.txt"] = install.constraints;
  }
  return out;
}

/** The script. `dir` is the environment folder and `source` the project's folder in the task worktree (read for `pyproject.toml` and `uv.lock`). */
export function buildScript(plan: PythonPlan, dir: string, source: string): string {
  const q = quoteWord;
  const lines: string[] = ["set -eu", `ENV=${q(dir)}`, `SRC=${q(source)}`, `step() { echo "${STEP}$1"; }`];
  const system = plan.system.filter(isDebianPackage);
  if (system.length > 0) {
    lines.push(
      `step ${q(`Fetching system packages: ${system.join(" ")}`)}`,
      'mkdir -p "$ENV/apt/state/lists/partial" "$ENV/apt/cache/archives/partial" "$ENV/sysroot"',
      'APT="-o Debug::NoLocking=1 -o Dir::State=$ENV/apt/state -o Dir::State::status=/var/lib/dpkg/status -o Dir::Cache=$ENV/apt/cache"',
      "apt-get $APT update",
      `apt-get $APT install -y --no-install-recommends --download-only ${system.map(q).join(" ")}`,
      'for f in "$ENV"/apt/cache/archives/*.deb; do [ -e "$f" ] && dpkg-deb -x "$f" "$ENV/sysroot"; done',
      // What a build needs from the folder: programs, headers, libraries and pkg-config files.
      'SYS="$ENV/sysroot"',
      'export PATH="$SYS/usr/bin:$PATH"',
      'LIBS=""',
      'for d in "$SYS"/usr/lib/*-linux-gnu "$SYS"/usr/lib "$SYS"/lib/*-linux-gnu; do [ -d "$d" ] && LIBS="$LIBS:$d"; done',
      'export LIBRARY_PATH="${LIBS#:}" LD_LIBRARY_PATH="${LIBS#:}"',
      'export C_INCLUDE_PATH="$SYS/usr/include:$SYS/usr/include/postgresql"',
      'export PKG_CONFIG_PATH="$SYS/usr/lib/pkgconfig:$SYS/usr/share/pkgconfig"',
    );
  }
  lines.push(
    'export UV_PYTHON_INSTALL_DIR="$ENV/python" UV_LINK_MODE=copy UV_COMPILE_BYTECODE=1 UV_NO_PROGRESS=1',
    `step ${q("Making the Python environment")}`,
  );
  const python = plan.python !== undefined && isWord(plan.python) ? ` --python ${plan.python}` : "";
  const sync = plan.installs.some((i) => i.kind === "uv-sync");
  // `uv sync` makes the environment itself, in the folder it is told to.
  if (!sync) lines.push(`uv venv --seed${python} "$ENV/venv"`);
  for (const install of plan.installs) {
    if (install.kind === "pip") {
      lines.push(
        `step ${q("Installing the packages of the requirements")}`,
        `uv pip install --python "$ENV/venv/bin/python" -r "$ENV/inputs/requirements.txt"${install.constraints === "" ? "" : ' -c "$ENV/inputs/constraints.txt"'}`,
      );
    } else if (install.kind === "pyproject") {
      const extras = install.extras.filter(isWord).map((e) => ` --extra ${e}`);
      lines.push(
        `step ${q("Installing the packages of pyproject.toml")}`,
        `uv pip install --python "$ENV/venv/bin/python" -r "$SRC/pyproject.toml"${extras.join("")}`,
      );
    } else {
      lines.push(
        `step ${q("Installing the packages of uv.lock")}`,
        `(cd "$SRC" && UV_PROJECT_ENVIRONMENT="$ENV/venv" uv sync --frozen --no-install-project --no-install-workspace${python})`,
      );
    }
  }
  lines.push(
    `step ${q("Checking the environment")}`,
    `"$ENV/venv/bin/python" -c 'import sys; print("${PYTHON_LINE}" + sys.version.split()[0])'`,
  );
  return `${lines.join("\n")}\n`;
}

/** The project's folder in a worktree. */
export const sourceOf = (worktree: string, plan: PythonPlan): string =>
  plan.dir === "" ? worktree : posix.join(worktree, plan.dir);
