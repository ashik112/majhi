import { describe, expect, it } from "vitest";
import { LayaDocker } from "./layaDocker.ts";
import { LayaProvider } from "./layaProvider.ts";

/** Plays laya-serve and the docker CLI: the container answers only after `docker start`. */
function fakes(options: { built?: boolean } = {}) {
  let running = false;
  const docker: string[][] = [];
  const posts: unknown[] = [];
  const cli = async (args: readonly string[]) => {
    docker.push([...args]);
    if (options.built === false) throw new Error("Error: No such object: majhi-laya");
    if (args[0] === "start") running = true;
    if (args[0] === "stop") running = false;
    if (args[0] === "inspect") return running ? "true\n" : "false\n";
    return "";
  };
  const fetchFake = (async (url: string | URL | Request, init?: RequestInit) => {
    if (!running) throw new TypeError("fetch failed");
    const path = new URL(String(url)).pathname;
    if (path === "/health")
      return Response.json({ status: "ok", loaded: posts.length > 0 ? ["english"] : [] });
    if (path === "/v1/systemone") {
      posts.push(JSON.parse(String(init?.body)));
      return Response.json({
        model: "english",
        answers: {
          team: {
            type: "choice",
            choice: "a builder and a reviewer",
            probabilities: { "one agent": 0.2, "a builder and a reviewer": 0.8 },
            confidence: 0.3,
          },
          owner: { type: "noul", noul: 0.9, confidence: 0.9 },
        },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const laya = new LayaDocker({
    url: "http://majhi-laya:8000",
    container: "majhi-laya",
    docker: cli,
    fetch: fetchFake,
    idleMs: 20,
    sleep: async () => {},
  });
  return { laya, docker, posts, isRunning: () => running };
}

const request = {
  state: "Add a health endpoint with a test",
  questions: {
    team: {
      type: "choice" as const,
      instructions: "Which team?",
      options: ["one agent", "a builder and a reviewer"],
    },
    owner: { type: "noul" as const, instructions: "Needs the owner?" },
  },
};

describe("Laya in Docker", () => {
  it("starts the container on the first question, answers through /v1/systemone and stops when idle", async () => {
    const { laya, docker, posts, isRunning } = fakes();
    expect(await laya.status()).toMatchObject({
      state: "ready",
      detail: expect.stringContaining("first question"),
    });
    const out = await laya.decide(request);
    expect(docker.map((a) => a[0])).toContain("start");
    expect(posts[0]).toMatchObject({
      model: "english",
      questions: {
        team: { type: "choice", criteria: ["one agent", "a builder and a reviewer"] },
        owner: { type: "noul" },
      },
    });
    expect(out.answers.team).toMatchObject({ value: "a builder and a reviewer", confidence: 0.8 });
    expect(out.answers.owner).toMatchObject({ value: true, confidence: 0.9 });
    expect(await laya.status()).toMatchObject({ state: "loaded" });
    await new Promise((r) => setTimeout(r, 60));
    expect(docker.at(-1)).toEqual(["stop", "majhi-laya"]);
    expect(isRunning()).toBe(false);
    laya.close();
  });

  it("says the image is not built when the container does not exist", async () => {
    const { laya } = fakes({ built: false });
    expect(await laya.status()).toMatchObject({
      state: "not-installed",
      detail: expect.stringContaining("make up"),
    });
    expect(await laya.unavailable()).toBe("Laya's Docker image is not built");
  });

  it("is what the Laya provider uses when the host helper is not there", async () => {
    const { laya } = fakes();
    const provider = new LayaProvider(undefined, laya);
    expect(await provider.unavailable()).toBeUndefined();
    const out = await provider.decide(request);
    expect(out.answers.team?.value).toBe("a builder and a reviewer");
    expect((await provider.status()).detail).toContain("Docker");
    laya.close();
    const none = new LayaProvider(undefined, fakes({ built: false }).laya);
    expect(await none.unavailable()).toBe(
      "The host helper is not connected. Laya's Docker image is not built",
    );
  });
});
