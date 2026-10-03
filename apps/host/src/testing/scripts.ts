/**
 * Runs a script from `scripts/` the way `make up` does, in a temp home, with fake programs first on
 * PATH and only the real tools the scripts need after them: a program a test does not fake is
 * missing, as on a computer without it.
 */
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);

export const SCRIPTS_DIR = fileURLToPath(new URL("../../../../scripts/", import.meta.url));

/** The real programs the scripts call. One this machine lacks (`timeout` on a Mac) stays missing. */
const TOOLS = [
  "cat",
  "chmod",
  "dirname",
  "grep",
  "head",
  "id",
  "ls",
  "mkdir",
  "mktemp",
  "mv",
  "printenv",
  "rm",
  "sed",
  "sleep",
  "sort",
  "tail",
  "timeout",
  "tr",
];

export type FakeOs = "linux" | "wsl" | "macos";

const UNAME: Record<FakeOs, { system: string; release: string }> = {
  linux: { system: "Linux", release: "6.8.0-45-generic" },
  wsl: { system: "Linux", release: "5.15.167.4-microsoft-standard-WSL2" },
  macos: { system: "Darwin", release: "24.0.0" },
};

export interface ScriptResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Sandbox {
  root: string;
  home: string;
  /** The fakes. */
  bin: string;
  /** Links to the real tools. */
  tools: string;
  /** The PATH a run gets unless the test passes its own: the fakes, then the tools. */
  path: string;
  /** Writes `bin/<name>`, a /bin/sh script with this body. */
  fake(name: string, body: string): Promise<void>;
  /** Takes a fake away again, so the program is missing. */
  remove(name: string): Promise<void>;
  /** A fake that appends its arguments to calls(name), one call per line, then runs `body`. */
  recorder(name: string, body?: string): Promise<void>;
  /** The calls a recorder saw, in order. */
  calls(name: string): Promise<string[]>;
  /** Forgets the calls seen so far. */
  clearCalls(): Promise<void>;
  /** Makes `uname` answer like this OS. */
  os(os: FakeOs): Promise<void>;
  run(script: string, args: string[], env?: Record<string, string>): Promise<ScriptResult>;
  cleanup(): Promise<void>;
}

async function which(name: string): Promise<string | undefined> {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    const path = join(dir, name);
    try {
      await access(path, constants.X_OK);
      return path;
    } catch {
      // Not in this folder.
    }
  }
  return undefined;
}

/** `homeName` is the home folder's name, so a test can put spaces and `%` in every path. */
export async function scriptSandbox(homeName = "home"): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), "majhi scripts "));
  const home = join(root, homeName);
  const bin = join(root, "bin");
  const tools = join(root, "tools");
  const callsDir = join(root, "calls");
  await Promise.all([home, bin, tools, callsDir].map((dir) => mkdir(dir, { recursive: true })));
  for (const tool of TOOLS) {
    const path = await which(tool);
    if (path !== undefined) await symlink(path, join(tools, tool));
  }

  const fake = async (name: string, body: string): Promise<void> => {
    const path = join(bin, name);
    await writeFile(path, `#!/bin/sh\n${body}\n`);
    await chmod(path, 0o755);
  };
  const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;
  const defaultPath = `${bin}${delimiter}${tools}`;

  return {
    root,
    home,
    bin,
    tools,
    path: defaultPath,
    fake,
    remove: (name) => rm(join(bin, name), { force: true }),
    recorder: (name, body = "exit 0") =>
      fake(name, `printf '%s\\n' "$*" >> ${quote(join(callsDir, name))}\n${body}`),
    async calls(name) {
      const text = await readFile(join(callsDir, name), "utf8").catch(() => "");
      return text.split("\n").filter((line) => line !== "");
    },
    async clearCalls() {
      await rm(callsDir, { recursive: true, force: true });
      await mkdir(callsDir);
    },
    os: (os) =>
      fake(
        "uname",
        `case "\${1:-}" in -r) echo ${UNAME[os].release} ;; -m) echo x86_64 ;; *) echo ${UNAME[os].system} ;; esac`,
      ),
    async run(script, args, env = {}) {
      const options = { cwd: root, env: { PATH: defaultPath, HOME: home, ...env } };
      try {
        const { stdout, stderr } = await exec("/bin/sh", [join(SCRIPTS_DIR, script), ...args], options);
        return { code: 0, stdout, stderr };
      } catch (err) {
        const failed = err as { code?: unknown; stdout?: string; stderr?: string };
        if (typeof failed.code !== "number") throw err;
        return { code: failed.code, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
      }
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
