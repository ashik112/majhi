import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configPass } from "./config/pass.ts";
import { ProjectFiles } from "./files.ts";
import { writeFixtures } from "./fixtures.ts";

const noRemotes = async () => [];

describe("config pass on the Acme fixtures", () => {
  it("draws the lines the config files show, each with a file and a line as proof", async () => {
    const { projects } = await writeFixtures();
    const { nodes, edges } = await configPass(projects, { remotes: noRemotes });
    const byId = new Map(edges.map((e) => [e.id, e]));
    // web calls the API (a URL in .env.example whose variable name says which project)
    expect(byId.get("acme-web>acme-api:http")).toMatchObject({
      label: "HTTP /v2",
      source: "config",
      state: "confirmed",
      evidence: [
        {
          project: "acme-web",
          file: ".env.example",
          line: 2,
          excerpt: "ACME_API_URL=https://api.acme.test/v2",
        },
      ],
    });
    // worker calls the API (a compose service name as the host)
    expect(byId.get("acme-worker>acme-api:http")?.evidence[0]).toMatchObject({
      file: ".env.example",
      line: 1,
    });
    // worker uses the shared library, found in package.json at its line
    expect(byId.get("acme-worker>worker-kit:lib")?.evidence[0]).toMatchObject({
      file: "package.json",
      line: 8,
      excerpt: '"worker-kit": "^1.20.0"',
    });
    // the API reads a database and a cache from compose, and the worker takes jobs through bullmq
    expect(byId.get("acme-api>store:postgres:data")?.evidence.map((p) => p.file)).toContain(
      "docker-compose.yml",
    );
    expect(byId.get("acme-api>store:redis:data")).toBeDefined();
    expect(byId.get("acme-worker>store:redis:queue")?.evidence[0]).toMatchObject({ file: "package.json" });
    // web uses Stripe through its SDK
    expect(byId.get("acme-web>outside:stripe:http")).toBeDefined();
    // the compose service builds the API itself: it depends on its own database and cache, not on itself
    expect(edges.some((e) => e.from === e.to)).toBe(false);

    const kind = (id: string) => nodes.find((n) => n.id === id)?.kind;
    expect(kind("acme-web")).toBe("project");
    expect(kind("worker-kit")).toBe("library");
    // a queue line makes a cache a queue
    expect(kind("store:redis")).toBe("queue");
    expect(kind("store:postgres")).toBe("database");
    expect(nodes.find((n) => n.id === "acme-web")?.deploy).toBe("Vercel");
    expect(nodes.find((n) => n.id === "acme-api")?.deploy).toBe("Docker");
  });

  it("is deterministic: the same checkouts give the same map", async () => {
    const { projects } = await writeFixtures();
    const a = await configPass(projects, { remotes: noRemotes });
    const b = await configPass(projects, { remotes: noRemotes });
    expect({ nodes: b.nodes, edges: b.edges }).toEqual({ nodes: a.nodes, edges: a.edges });
  });

  it("never writes a password or a secret value into proof", async () => {
    const { projects } = await writeFixtures();
    const { edges } = await configPass(projects, { remotes: noRemotes });
    const text = JSON.stringify(edges);
    expect(text).not.toContain("secretpw");
    expect(text).not.toContain("sk_test_abc");
    expect(text).toContain("postgres://db:5432/orders");
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

  it("reads Kubernetes env, Helm values and a pnpm style monorepo manifest with real parsers", async () => {
    const { projects } = await writeFixtures({
      "acme-worker": {
        "k8s/deploy.yaml": [
          "apiVersion: apps/v1",
          "kind: Deployment",
          "spec:",
          "  template:",
          "    spec:",
          "      containers:",
          "        - name: worker",
          "          env:",
          "            - name: BROKER_URL",
          "              value: amqp://guest:guest@rabbit:5672",
          "",
        ].join("\n"),
      },
    });
    const { edges, nodes } = await configPass(projects, { remotes: noRemotes });
    const line = edges.find((e) => e.id === "acme-worker>store:rabbitmq:queue");
    expect(line?.evidence[0]).toMatchObject({
      file: "k8s/deploy.yaml",
      line: 9,
      excerpt: "BROKER_URL=amqp://rabbit:5672",
    });
    expect(nodes.find((n) => n.id === "acme-worker")?.deploy).toBe("Kubernetes");
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
