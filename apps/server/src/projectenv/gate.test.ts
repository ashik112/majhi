import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RoomItem } from "@majhi/shared";
import { afterEach, expect, it } from "vitest";
import { git } from "../testing/fixtures.ts";
import { until } from "../testing/until.ts";
import { taskWorld, type World } from "../testing/world.ts";
import type { BuildResult } from "./service.ts";

/**
 * A code task of a project with a check starts its agent only when the project's dependencies are
 * installed, and every task of the project uses the same environment. The runner that installs is a fake:
 * no package is fetched and no docker runs.
 */

let w: World;
afterEach(() => w?.cleanup());

const CI = `name: ci
on: [push]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: pip install -r requirements.txt
      - run: pytest
`;

const BUILT: BuildResult = {
  code: 0,
  timedOut: false,
  output: "==> Checking the environment\nmajhi-python 3.11.2\n",
};
const BROKEN: BuildResult = {
  code: 1,
  timedOut: false,
  output: "==> Installing the packages of the requirements\nerror: failed to build psycopg2\n",
};

/** The project's CI file and requirements, on the branches tasks start from. */
async function commitPythonProject(repo: string): Promise<void> {
  await mkdir(join(repo, ".github", "workflows"), { recursive: true });
  await writeFile(join(repo, ".github", "workflows", "ci.yml"), CI);
  await writeFile(join(repo, "requirements.txt"), "django==5.0\npsycopg2==2.9.9\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "--quiet", "-m", "python project");
  await git(repo, "branch", "-f", "develop", "main");
  await git(repo, "push", "--quiet", "-f", "origin", "main", "develop");
}

/** The runner of a build: each call waits until the test finishes it. */
function builds() {
  const calls: { task: string; script: string; finish: (result: BuildResult) => void }[] = [];
  return {
    calls,
    exec: (task: string, _cwd: string, script: string) =>
      new Promise<BuildResult>((finish) => calls.push({ task, script, finish })),
  };
}

const items = async (task: string): Promise<RoomItem[]> =>
  (await w.h.cmd("room.items", { task, limit: 500 })).body.items as RoomItem[];

it("keeps the agent from starting until the project environment is ready, and a failed build makes one room line and starts it without", async () => {
  const fake = builds();
  w = await taskWorld({ projectEnvExec: fake.exec });
  await commitPythonProject(w.repo("api"));
  const started: string[] = [];
  w.h.runtime.onSession = (session) => {
    started.push("session");
    session.script = async () => "end_turn";
  };

  await w.h.cmd("tasks.create", { text: "fix api", repos: [{ project: "acme-api" }], start: true });
  await until(() => fake.calls.length === 1);
  // The build is under way: one line with the clock, and the agent has not started.
  const live = () => w.h.majhi.services.room.getLive("ACM-1", "acme-builder");
  await until(() => live()?.nowDoing?.startsWith("Preparing the project's environment (0:") === true);
  expect(started).toEqual([]);
  // The system packages psycopg2 needs to build come from the table of known needs.
  expect(fake.calls[0]?.script).toContain("libpq-dev");

  fake.calls[0]?.finish(BROKEN);
  // A failed build holds nothing: the agent starts without the environment, with no card.
  await until(() => started.length === 1);
  const all = await items("ACM-1");
  expect(all.filter((i) => i.type === "paused" || i.type === "review")).toEqual([]);
  const lines = all.flatMap((i) =>
    i.type === "system" && i.text.includes("could not be built") ? [i.text] : [],
  );
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("Installing the packages of the requirements failed");
  expect(lines[0]).toContain(
    "```\n==> Installing the packages of the requirements\nerror: failed to build psycopg2",
  );
  const asked = async (task: string) => readFile(join(w.taskDir(task), "TASK.md"), "utf8");
  expect(await asked("ACM-1")).toContain(
    "The project environment failed to build (see the room). Install what you need yourself.",
  );

  // The next task of the project does not try the same build again.
  await w.h.cmd("tasks.create", { text: "fix api again", repos: [{ project: "acme-api" }], start: true });
  await until(() => started.length === 2);
  expect(fake.calls).toHaveLength(1);
});

it("gives a second task of the project the same environment, with no second build", async () => {
  const fake = builds();
  w = await taskWorld({ projectEnvExec: fake.exec });
  await commitPythonProject(w.repo("api"));
  const started: string[] = [];
  w.h.runtime.onSession = (session) => {
    started.push("session");
    session.script = async () => "end_turn";
  };

  await w.h.cmd("tasks.create", { text: "fix api", repos: [{ project: "acme-api" }], start: true });
  await until(() => fake.calls.length === 1);
  fake.calls[0]?.finish(BUILT);
  await until(() => started.length === 1);
  expect(await readFile(join(w.taskDir("ACM-1"), "TASK.md"), "utf8")).toContain(
    "Environment ready: Python 3.11.2",
  );

  await w.h.cmd("tasks.create", { text: "fix api again", repos: [{ project: "acme-api" }], start: true });
  await until(() => started.length === 2);
  expect(fake.calls).toHaveLength(1);
});
