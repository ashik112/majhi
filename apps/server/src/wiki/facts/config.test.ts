import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectFiles } from "./files.ts";
import { ACCURACY_FILES, writeFixtures } from "./fixtures.ts";
import { configPass } from "./pass.ts";

const noRemotes = async () => [];

describe("config pass on the Acme fixtures", () => {
  it("takes an address from a variable only when it is a call: not origins, CORS, a name with no URL or an outside API", async () => {
    const { projects } = await writeFixtures({}, ACCURACY_FILES);
    const { endpoints } = await configPass(projects, { remotes: noRemotes });
    expect(endpoints.map((e) => e.id).toSorted()).toEqual([
      "acme-api@localhost:8000",
      "acme-billing@localhost:8000",
      "api.acme.test",
      "api.partsco.test",
      "api:8000",
    ]);
  });

  it("draws a line between projects only for an address a file proves", async () => {
    const { projects } = await writeFixtures({}, ACCURACY_FILES);
    const { edges } = await configPass(projects, { remotes: noRemotes });
    // `api` is a compose service that acme-api builds. api.acme.test, api.partsco.test and localhost:8000
    // look like projects by name or port, and draw nothing until the owner answers.
    const { endpoints } = await configPass(projects, { remotes: noRemotes });
    expect(edges.filter((e) => e.type === "http")).toEqual([]);
    expect(endpoints.find((e) => e.id === "api:8000")?.known).toBe("acme-api");
    expect(endpoints.find((e) => e.id === "api.acme.test")?.known).toBeUndefined();
  });

  it("never makes a shared datastore from a driver or a local name; the same remote URL does", async () => {
    const { projects } = await writeFixtures({}, ACCURACY_FILES);
    const { nodes, edges } = await configPass(projects, { remotes: noRemotes });
    const stores = nodes.filter((n) => n.id.startsWith("store:"));
    // Two projects with their own Postgres at localhost, and both with a driver: no shared database.
    expect(stores.map((n) => n.kind)).toEqual(["queue"]);
    expect(
      edges
        .filter((e) => e.to === stores[0]?.id)
        .map((e) => e.from)
        .toSorted(),
    ).toEqual(["acme-jobs", "acme-worker"]);
    expect(nodes.find((n) => n.id === "acme-api")?.stack).toContain("Postgres");
    expect(nodes.find((n) => n.id === "acme-billing")?.stack).toContain("Postgres");
  });

  it("is deterministic: the same checkouts give the same map", async () => {
    const { projects } = await writeFixtures();
    const a = await configPass(projects, { remotes: noRemotes });
    const b = await configPass(projects, { remotes: noRemotes });
    expect({ nodes: b.nodes, edges: b.edges }).toEqual({ nodes: a.nodes, edges: a.edges });
  });

  it("never writes a password or a secret value into proof", async () => {
    const { projects } = await writeFixtures();
    const { edges, endpoints, nodes } = await configPass(projects, { remotes: noRemotes });
    const text = JSON.stringify({ edges, endpoints, nodes });
    expect(text).not.toContain("secretpw");
    expect(text).not.toContain("sk_test_abc");
  });

  it("finds a library by its git remote and a local path, not only by name", async () => {
    const { projects } = await writeFixtures({
      "acme-web": {
        "package.json": JSON.stringify(
          {
            name: "acme-web",
            dependencies: {
              "kit-by-git": "git+ssh://git@github.com/acme/worker-kit.git#v1",
              "kit-by-path": "file:../worker-kit",
            },
          },
          null,
          2,
        ),
      },
    });
    const { edges } = await configPass(projects, {
      remotes: async (path) => (path.endsWith("worker-kit") ? ["git@github.com:acme/worker-kit.git"] : []),
    });
    const lib = edges.find((e) => e.id === "acme-web>worker-kit:lib");
    expect(lib?.evidence.map((p) => p.excerpt)).toEqual([
      '"kit-by-git": "git+ssh://git@github.com/acme/worker-kit.git#v1",',
      '"kit-by-path": "file:../worker-kit"',
    ]);
  });

  it("does not read what it should not: broken files, and links out of the checkout", async () => {
    const { root, projects } = await writeFixtures({
      "acme-web": { "docker-compose.yml": "services: [unclosed\n  - : :\n" },
    });
    // A symlink that leaves the checkout reads as missing.
    await mkdir(join(root, "outside"), { recursive: true });
    await writeFile(join(root, "outside", "secret.txt"), "top secret");
    await symlink(join(root, "outside", "secret.txt"), join(root, "acme-web", "leak.txt"));
    const files = new ProjectFiles(join(root, "acme-web"));
    expect(await files.read("leak.txt")).toBeUndefined();
    expect(await files.read("../outside/secret.txt")).toBeUndefined();
    expect(await files.read("package.json")).toContain("acme-web");
    // A compose file that does not parse adds nothing and does not stop the pass.
    const { edges } = await configPass(projects, { remotes: noRemotes });
    expect(edges.length).toBeGreaterThan(0);
  });
});
