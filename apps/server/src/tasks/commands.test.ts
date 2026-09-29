import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { git } from "../testing/fixtures.ts";
import { taskWorld, type World } from "../testing/world.ts";

let w: World;
afterEach(() => w?.cleanup());

const create = (text: string, extra: Record<string, unknown> = {}) =>
  w.h.cmd("tasks.create", { text, start: false, ...extra });
const idle = () => w.h.majhi.services.runs.idle();

describe("tasks.create", () => {
  it("parses the text on the server and creates an inbox task with its folder", async () => {
    w = await taskWorld();
    const res = await create("add a health endpoint to api from develop");
    expect(res.status).toBe(200);
    const task = res.body;
    expect(task).toMatchObject({
      id: "ACM-1",
      title: "add a health endpoint to api from develop",
      brief: "add a health endpoint to api from develop",
      kind: "code",
      org: "acme",
      status: "inbox",
      folder: w.taskDir("ACM-1"),
      team: ["acme-builder"],
      links: [],
      attachments: [],
      repos: [
        {
          project: "acme-api",
          source: w.repo("api"),
          base: "develop",
          branch: "task/acm-1-add-a-health-endpoint-to-api",
          createdBranch: true,
        },
      ],
    });
    expect(task.repos[0].worktree).toBeUndefined();

    const taskMd = await readFile(join(task.folder, "TASK.md"), "utf8");
    expect(taskMd).toContain("# ACM-1: add a health endpoint to api from develop");
    expect(taskMd).toContain(
      `- acme-api: worktree \`${join(task.folder, "acme-api")}\`, branch \`task/acm-1-add-a-health-endpoint-to-api\` (new, from \`develop\`)`,
    );
    expect(taskMd).toContain("@acme-builder (Builder)");
    expect(taskMd).toContain("Never push");
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      expect(await readFile(join(task.folder, name), "utf8")).toContain("Read TASK.md in this folder first");
    }
    expect(existsSync(join(task.folder, "acme-api"))).toBe(false);

    const list = await w.h.cmd("tasks.list", {});
    expect(list.body).toEqual([
      {
        id: "ACM-1",
        title: "add a health endpoint to api from develop",
        kind: "code",
        org: "acme",
        status: "inbox",
        team: ["acme-builder"],
        updatedAt: task.updatedAt,
        repos: [{ project: "acme-api", branch: "task/acm-1-add-a-health-endpoint-to-api" }],
        working: [],
      },
    ]);
  });

  it("numbers tasks per key and uses the project base and the named branch", async () => {
    w = await taskWorld();
    await git(w.repo("api"), "branch", "feat/existing", "develop");
    const one = (await create("fix api")).body;
    const two = (await create("more work on api on feat/existing")).body;
    expect(one.id).toBe("ACM-1");
    expect(one.repos[0]).toMatchObject({ base: "main", createdBranch: true });
    expect(two.id).toBe("ACM-2");
    expect(two.repos[0]).toMatchObject({ branch: "feat/existing", base: "main", createdBranch: false });
  });

  it("derives the key from the org name when the org has none", async () => {
    w = await taskWorld();
    await w.h.cmd("orgs.create", { id: "beta", name: "Beta Labs" });
    await w.addRepo("web");
    await w.h.cmd("projects.register", { id: "beta-web", org: "beta", path: "~/Work/web", aliases: ["web"] });
    await w.h.cmd("agents.create", {
      id: "beta-lead",
      frontmatter: { scope: "beta", role: "Lead", account: "claude-acme" },
      instructions: "",
    });
    const res = await create("fix web");
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("BL-1");
  });

  it("uses an @mentioned agent, and refuses one that cannot work in the org", async () => {
    w = await taskWorld();
    await w.h.cmd("agents.create", {
      id: "acme-lead",
      frontmatter: { scope: "acme", role: "Lead", account: "claude-acme" },
      instructions: "",
    });
    await w.h.cmd("agents.create", {
      id: "other-builder",
      frontmatter: { scope: "beta", role: "Builder", account: "claude-acme", where: ["beta"] },
      instructions: "",
    });
    expect((await create("fix api")).body.team).toEqual(["acme-lead"]);
    expect((await create("@acme-builder fix api")).body.team).toEqual(["acme-builder"]);
    expect((await create("fix api", { agent: "acme-builder" })).body.team).toEqual(["acme-builder"]);
    const refused = await create("fix api", { agent: "other-builder" });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe('@other-builder cannot work in "acme".');
    expect((await create("fix api", { agent: "ghost" })).status).toBe(400);
  });

  it("refuses repos from two orgs and code tasks without a repo", async () => {
    w = await taskWorld();
    await w.h.cmd("orgs.create", { id: "beta", name: "Beta" });
    await w.addRepo("web");
    await w.h.cmd("projects.register", { id: "beta-web", org: "beta", path: "~/Work/web", aliases: ["web"] });
    const multi = await create("fix api and web");
    expect(multi.status).toBe(400);
    expect(multi.body.error).toBe("Repos from more than one org: acme, beta. Make one task per org.");
    const noRepo = await create("think about things", { kind: "code" });
    expect(noRepo.status).toBe(400);
    expect(noRepo.body.error).toBe("A code task needs a project. Name one in the text, or change the kind.");
    expect((await w.h.cmd("tasks.list", {})).body).toEqual([]);
  });

  it("makes a chat task without an org and hands it to the boss", async () => {
    w = await taskWorld();
    await w.h.cmd("agents.create", {
      id: "majhi-boss",
      frontmatter: { scope: "root", role: "Root", account: "claude-acme" },
      instructions: "",
    });
    await w.h.cmd("boss.set", { id: "majhi-boss" });
    const res = await create("what is a monad");
    expect(res.body).toMatchObject({ id: "LOCAL-1", kind: "chat", team: ["majhi-boss"], repos: [] });
    expect(res.body.org).toBeUndefined();
    expect(await readFile(join(res.body.folder, "TASK.md"), "utf8")).toContain(
      "No repos. Work in this folder.",
    );
  });

  it("saves a task with no agent, but will not start it", async () => {
    w = await taskWorld({ noAgent: true });
    const saved = await create("fix api");
    expect(saved.body.team).toEqual([]);
    const started = await create("fix api again", { start: true });
    expect(started.status).toBe(409);
    expect(started.body.error).toBe('No agent can work in "acme". Create one in Studio.');
    expect((await w.h.cmd("tasks.list", {})).body).toHaveLength(1);
  });

  it("posts a warning for an unknown agent mention", async () => {
    w = await taskWorld();
    const res = await create("fix api @ghost");
    const page = await w.h.cmd("room.items", { task: res.body.id });
    expect(page.body.items.map((i: { text: string }) => i.text)).toEqual(["Unknown agent @ghost"]);
  });
});

describe("attachments and links", () => {
  const html =
    "<html><head><title>The Spec</title><style>x{}</style></head><body><h1>Spec</h1><p>Do <b>this</b> &amp; that.</p><script>evil()</script></body></html>";

  it("moves uploads into attachments/ and fetches links once as markdown", async () => {
    const calls: string[] = [];
    w = await taskWorld({
      links: {
        fetchImpl: async (url) => {
          calls.push(String(url));
          return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
        },
      },
    });
    const form = new FormData();
    form.set("file", new File(["hello"], "notes.txt", { type: "text/plain" }));
    const up = await w.h.majhi.app.request("/api/uploads", { method: "POST", body: form });
    expect(up.status).toBe(200);
    const attachment = (await up.json()) as { id: string };
    expect(attachment).toMatchObject({ kind: "file", name: "notes.txt", mime: "text/plain", size: 5 });

    const res = await create("see https://example.com/spec for api", { attachments: [attachment.id] });
    expect(res.status).toBe(200);
    expect(calls).toEqual(["https://example.com/spec"]);
    const [file, link] = res.body.attachments;
    expect(file).toMatchObject({
      id: attachment.id,
      kind: "file",
      name: "notes.txt",
      path: "notes.txt",
      size: 5,
    });
    expect(link).toMatchObject({
      kind: "link",
      url: "https://example.com/spec",
      name: "The Spec",
      mime: "text/markdown",
    });
    expect(link.path).toBe("link-1-example-com-spec.md");
    const md = await readFile(join(res.body.folder, "attachments", link.path), "utf8");
    expect(md).toBe("# The Spec\n\nSource: https://example.com/spec\n\nSpec\n\nDo this & that.\n");
    expect(await readFile(join(res.body.folder, "attachments", "notes.txt"), "utf8")).toBe("hello");
    const taskMd = await readFile(join(res.body.folder, "TASK.md"), "utf8");
    expect(taskMd).toContain("- notes.txt: `attachments/notes.txt` (file)");
    expect(taskMd).toContain(
      "- https://example.com/spec: fetched to `attachments/link-1-example-com-spec.md`",
    );
    // The upload is gone from the cache.
    const again = await create("api", { attachments: [attachment.id] });
    expect(again.status).toBe(400);
    expect(again.body.error).toContain("is gone");
  });

  it("records a failed link on the attachment and carries on", async () => {
    w = await taskWorld({ links: { fetchImpl: async () => new Response("nope", { status: 404 }) } });
    const res = await create("read https://example.com/missing for api");
    expect(res.status).toBe(200);
    expect(res.body.attachments).toEqual([
      {
        id: "link-1",
        kind: "link",
        name: "https://example.com/missing",
        url: "https://example.com/missing",
        error: "The server answered 404",
      },
    ]);
    expect(await readFile(join(res.body.folder, "TASK.md"), "utf8")).toContain(
      "could not be fetched (The server answered 404)",
    );
  });

  it("detects images by mime type", async () => {
    w = await taskWorld();
    const form = new FormData();
    form.set("file", new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" }));
    const up = await (await w.h.majhi.app.request("/api/uploads", { method: "POST", body: form })).json();
    expect(up).toMatchObject({ kind: "image", name: "shot.png", mime: "image/png", size: 4 });
  });

  it("rejects uploads from other origins, without a file, and over 20 MB", async () => {
    w = await taskWorld();
    const form = () => {
      const f = new FormData();
      f.set("file", new File(["x"], "a.txt"));
      return f;
    };
    const post = (init: RequestInit) => w.h.majhi.app.request("/api/uploads", { method: "POST", ...init });
    expect((await post({ body: form(), headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await post({ body: form(), headers: { origin: "http://localhost:5173" } })).status).toBe(200);
    expect((await post({ body: new FormData() })).status).toBe(400);
    const big = new FormData();
    big.set("file", new File([new Uint8Array(20 * 1024 * 1024 + 1)], "big.bin"));
    expect((await post({ body: big })).status).toBe(413);
  });
});

describe("tasks.start", () => {
  it("creates the worktree on a new branch from the base and runs the agent", async () => {
    w = await taskWorld();
    const res = await create("add a health endpoint to api from develop", { start: true });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("running");
    const wt = join(res.body.folder, "acme-api");
    expect(res.body.repos[0].worktree).toBe(wt);
    expect(await git(wt, "symbolic-ref", "--short", "HEAD")).toBe("task/acm-1-add-a-health-endpoint-to-api");
    expect((await stat(join(wt, "README.md"))).isFile()).toBe(true);

    await idle();
    const session = w.h.runtime.sessions[0];
    expect(w.h.runtime.starts[0]).toMatchObject({ cwd: res.body.folder, model: "sonnet", effort: "high" });
    expect(session?.prompts).toHaveLength(1);
    expect(session?.prompts[0]).toEqual([
      {
        type: "text",
        text: "Read TASK.md in this folder, then do the task it describes. Say what you are about to change before you change it.",
      },
    ]);
    const items = (await w.h.cmd("room.items", { task: "ACM-1" })).body.items.reverse();
    expect(items.map((i: { type: string; text?: string }) => [i.type, i.text])).toEqual([
      ["owner", "add a health endpoint to api from develop"],
      ["system", "@acme-builder started on claude-acme, model sonnet, effort high"],
      ["agent", "ok"],
    ]);
    // The task list says who is working, and the room's agent is idle.
    expect(w.h.majhi.services.room.getLive("ACM-1", "acme-builder")).toMatchObject({
      status: "idle",
      model: "sonnet",
      effort: "high",
      queued: 0,
    });
  });

  it("is safe to repeat and moves ready to running", async () => {
    w = await taskWorld();
    const made = await create("fix api");
    expect(made.body.status).toBe("inbox");
    const first = await w.h.cmd("tasks.start", { id: "ACM-1" });
    expect(first.body.status).toBe("running");
    await idle();
    const second = await w.h.cmd("tasks.start", { id: "ACM-1" });
    expect(second.body.status).toBe("running");
    await idle();
    expect(w.h.runtime.sessions).toHaveLength(1);
    expect(w.h.runtime.sessions[0]?.prompts).toHaveLength(1);
  });

  it("checks out a branch that exists, fetching it, and warns when the remote is offline", async () => {
    w = await taskWorld();
    await git(w.repo("api"), "branch", "feat/existing", "develop");
    await git(w.repo("api"), "remote", "set-url", "origin", join(w.h.dir, "gone.git"));
    const res = await create("fix api on feat/existing", { start: true });
    expect(res.status).toBe(200);
    expect(res.body.repos[0]).toMatchObject({ branch: "feat/existing", createdBranch: false });
    const items = (await w.h.cmd("room.items", { task: res.body.id })).body.items;
    const warn = items.find(
      (i: { type: string; level?: string }) => i.type === "system" && i.level === "warn",
    );
    expect(warn.text).toMatch(/^acme-api: Could not fetch main from origin/);
  });

  it("fails loudly when the base does not exist, and the task stays ready", async () => {
    w = await taskWorld();
    const res = await create("fix api from nope", { start: true });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe(
      `Task ACM-1 was created but did not start: acme-api: Base branch "nope" was not found in ${w.repo("api")}.`,
    );
    expect((await w.h.cmd("tasks.get", { id: "ACM-1" })).body.status).toBe("ready");
    expect(w.h.runtime.sessions).toHaveLength(0);
  });

  it("starts a chat task without worktrees", async () => {
    w = await taskWorld();
    await w.h.cmd("agents.create", {
      id: "majhi-boss",
      frontmatter: { scope: "root", role: "Root", account: "claude-acme" },
      instructions: "",
    });
    await w.h.cmd("boss.set", { id: "majhi-boss" });
    const res = await create("what is a monad", { start: true });
    expect(res.body).toMatchObject({ id: "LOCAL-1", status: "running" });
    await idle();
    expect(w.h.runtime.starts[0]?.cwd).toBe(res.body.folder);
  });
});

describe("stopping, closing and removing", () => {
  it("stops a task: paused with reason owner, sessions closed", async () => {
    w = await taskWorld();
    await create("fix api", { start: true });
    await idle();
    const res = await w.h.cmd("tasks.stop", { id: "ACM-1" });
    expect(res.body).toMatchObject({ status: "paused", pausedReason: "owner" });
    expect(w.h.runtime.sessions[0]?.closed).toBe(true);
    expect(w.h.majhi.services.room.getLive("ACM-1", "acme-builder")?.status).toBe("stopped");
    const done = await w.h.cmd("tasks.close", { id: "ACM-1" });
    expect(done.body.status).toBe("done");
    expect((await w.h.cmd("tasks.list", {})).body).toEqual([]);
    expect((await w.h.cmd("tasks.list", { includeDone: true })).body).toHaveLength(1);
    expect((await w.h.cmd("tasks.start", { id: "ACM-1" })).status).toBe(409);
  });

  it("refuses to remove a task with uncommitted changes unless forced", async () => {
    w = await taskWorld();
    const made = await create("fix api", { start: true });
    await idle();
    const wt = join(made.body.folder, "acme-api");
    await writeFile(join(wt, "work.txt"), "unsaved");
    const refused = await w.h.cmd("tasks.remove", { id: "ACM-1" });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain(`Uncommitted changes in ${wt}`);
    expect(refused.body.details).toEqual(["acme-api: ?? work.txt"]);
    expect(existsSync(wt)).toBe(true);
    expect((await w.h.cmd("tasks.get", { id: "ACM-1" })).status).toBe(200);

    const forced = await w.h.cmd("tasks.remove", { id: "ACM-1", force: true });
    expect(forced.body).toEqual({ removed: "ACM-1" });
    expect(existsSync(made.body.folder)).toBe(false);
    expect(await git(w.repo("api"), "worktree", "list", "--porcelain")).not.toContain("acm-1");
    expect((await w.h.cmd("tasks.get", { id: "ACM-1" })).status).toBe(404);
    // The next task does not reuse the number.
    expect((await create("again api")).body.id).toBe("ACM-2");
  });

  it("removes a clean task with its worktree and folder", async () => {
    w = await taskWorld();
    const made = await create("fix api", { start: true });
    await idle();
    expect((await w.h.cmd("tasks.remove", { id: "ACM-1" })).status).toBe(200);
    expect(existsSync(made.body.folder)).toBe(false);
    await mkdir(made.body.folder, { recursive: true }); // a folder left behind must not break a later task
  });

  it("does not let a project be removed while an open task uses it", async () => {
    w = await taskWorld();
    await create("fix api");
    const res = await w.h.cmd("projects.remove", { id: "acme-api" });
    expect(res.status).toBe(409);
    expect(res.body.details).toEqual(["ACM-1"]);
  });
});
