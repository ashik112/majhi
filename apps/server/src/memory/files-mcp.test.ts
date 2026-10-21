import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FILES_SERVER_NAME, RoomAccess } from "../rooms/access.ts";
import { type RoomMcpDeps, roomMcpRoutes } from "../rooms/mcp.ts";
import { refuseAll } from "../rooms/session-decision.ts";

/** A repo export with two lines, a note beside it, and a secret file next to it that a link inside the export points at. */
async function exportOf() {
  const base = await mkdtemp(join(tmpdir(), "majhi-files-"));
  const root = join(base, "acme-api");
  const other = join(base, "acme-web");
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(other);
  await writeFile(join(root, "src", "app.ts"), "export const name = 'acme';\nexport const port = 7070;\n");
  await writeFile(join(other, "main.ts"), "export const web = true;\n");
  await writeFile(join(base, "secret.txt"), "token=acme-secret\n");
  await symlink(join(base, "secret.txt"), join(root, "link.txt"));
  await symlink(base, join(root, "up"));
  return { base, root, other };
}

function setup() {
  const access = new RoomAccess(
    () => "http://majhi-server:7070/mcp",
    () => true,
  );
  const app = roomMcpRoutes({ access } as unknown as RoomMcpDeps);
  let id = 0;
  const call = async (token: string | undefined, tool: string, args: Record<string, unknown>) => {
    const res = await app.request("/mcp/files", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++id,
        method: "tools/call",
        params: { name: tool, arguments: args },
      }),
    });
    if (res.status !== 200) return { status: res.status, text: "" };
    const body = (await res.json()) as { result: { content: { text: string }[]; isError?: boolean } };
    return {
      status: 200,
      text: body.result.content.map((c) => c.text).join("\n"),
      error: body.result.isError,
    };
  };
  return { access, call };
}

describe("the files tools of a read-only session", () => {
  it("read inside the folders with numbered lines, and refuse everything outside them", async () => {
    const { root, other, base } = await exportOf();
    const { access, call } = setup();
    const { entry, server } = access.attachFiles({ root, also: [other] });
    expect(server.name).toBe(FILES_SERVER_NAME);
    const token = entry.token;

    // Inside: the right lines, in the shape of `cat -n`, by a relative path and by an absolute one, and another repo of the workspace.
    const app = "     1\texport const name = 'acme';\n     2\texport const port = 7070;";
    expect((await call(token, "read", { path: "src/app.ts" })).text).toBe(app);
    expect((await call(token, "read", { path: join(root, "src", "app.ts") })).text).toBe(app);
    expect((await call(token, "read", { path: "src/app.ts", first_line: 2 })).text).toBe(
      "     2\texport const port = 7070;",
    );
    expect((await call(token, "read", { path: "src/app.ts", line_count: 1 })).text).toBe(
      "     1\texport const name = 'acme';\n[Cut here: more lines follow. Continue with first_line 2.]",
    );
    expect((await call(token, "read", { path: join(other, "main.ts") })).text).toBe(
      "     1\texport const web = true;",
    );
    expect((await call(token, "list", {})).text).toBe("link.txt\nsrc/\nup");
    expect((await call(token, "search", { text: "PORT =" })).text).toBe(
      `${join(root, "src", "app.ts")}:2: export const port = 7070;`,
    );

    // Outside: a climb out, an absolute path, a link to a file outside, a link to a folder outside, and /proc.
    for (const path of [
      "../secret.txt",
      join(base, "secret.txt"),
      "link.txt",
      "up/secret.txt",
      "/proc/self/environ",
    ]) {
      const answer = await call(token, "read", { path });
      expect(answer, path).toMatchObject({
        error: true,
        text: `${path} is outside the folders this session may read.`,
      });
    }
    expect((await call(token, "list", { path: ".." })).error).toBe(true);
    expect((await call(token, "list", { path: "up" })).error).toBe(true);
    expect((await call(token, "search", { text: "secret", path: "up" })).error).toBe(true);
    // A search of the whole folder never follows the links out.
    expect((await call(token, "search", { text: "acme-secret" })).text).toBe("No matches.");
  });

  it("answer only for their own session's folders: another session's token, a revoked one and none are refused", async () => {
    const acme = await exportOf();
    const globex = await exportOf();
    const { access, call } = setup();
    const a = access.attachFiles({ root: acme.root, also: [] });
    const g = access.attachFiles({ root: globex.root, also: [] });

    // Each token reads its own folder, and the other session's folder is outside it, whatever path names it.
    expect((await call(a.entry.token, "read", { path: "src/app.ts" })).status).toBe(200);
    expect(await call(a.entry.token, "read", { path: join(globex.root, "src", "app.ts") })).toMatchObject({
      error: true,
      text: `${join(globex.root, "src", "app.ts")} is outside the folders this session may read.`,
    });
    expect((await call(g.entry.token, "read", { path: join(acme.root, "src", "app.ts") })).error).toBe(true);

    expect((await call(undefined, "list", {})).status).toBe(401);
    expect((await call("not-a-token", "list", {})).status).toBe(401);
    // A hook token is not a files token.
    const hook = access.attachCodexSession({ decide: refuseAll("no"), servers: [] });
    expect((await call(hook.entry.token, "list", {})).status).toBe(401);

    access.revoke([a.entry]);
    expect((await call(a.entry.token, "list", {})).status).toBe(401);
    expect((await call(g.entry.token, "list", {})).status).toBe(200);
  });
});
