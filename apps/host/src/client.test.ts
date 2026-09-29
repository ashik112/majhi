import { HOST_INFO_HEADER, type HostInfo, type HostJob } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { pollLoop } from "./client.ts";

const INFO: HostInfo = { version: "1.0.0", platform: "darwin", canRemount: false };
const JOB: HostJob = { id: "j1", method: "suggestRoots", params: {} };

type Step = Response | Error;

/**
 * Runs the poll loop against scripted answers, one per request, and stops it
 * when the script runs out. Sleeps are recorded, not waited.
 */
async function runScript(steps: Step[]) {
  const controller = new AbortController();
  const sleeps: number[] = [];
  const jobs: HostJob[] = [];
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const logs: string[] = [];
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requests.push({ url: String(input), init });
    // Replies are not part of the poll script.
    if (String(input).endsWith("/api/host/reply")) return new Response(null, { status: 204 });
    const step = steps.shift();
    if (steps.length === 0) controller.abort();
    if (step === undefined) throw new Error("script ran out");
    if (step instanceof Error) throw step;
    return step;
  };
  await pollLoop({
    url: "http://127.0.0.1:7070",
    token: async () => "tok",
    info: INFO,
    log: (m) => logs.push(m),
    fetch: fakeFetch as typeof fetch,
    signal: controller.signal,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    onJob: (job) => jobs.push(job),
  });
  return { sleeps, jobs, requests, logs };
}

const refused = () =>
  new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:7070") });
const empty = () => new Response(null, { status: 204 });
const json = (body: unknown) => Response.json(body);

describe("pollLoop", () => {
  it("backs off from 250 ms, doubling up to 5 s, and starts over after a success", async () => {
    const down = Array.from({ length: 7 }, refused);
    const { sleeps, logs } = await runScript([...down, empty(), refused(), refused(), empty()]);
    expect(sleeps).toEqual([250, 500, 1000, 2000, 4000, 5000, 5000, 250, 500]);
    // One line per change of state, not one per failed attempt.
    expect(logs).toEqual([
      "cannot reach majhi at http://127.0.0.1:7070 (connect ECONNREFUSED 127.0.0.1:7070), retrying",
      "connected to majhi at http://127.0.0.1:7070",
      "cannot reach majhi at http://127.0.0.1:7070 (connect ECONNREFUSED 127.0.0.1:7070), retrying",
      "connected to majhi at http://127.0.0.1:7070",
    ]);
  });

  it("sends the token and helper info, and hands jobs over without waiting between polls", async () => {
    const { jobs, sleeps, requests } = await runScript([json(JOB), empty()]);
    expect(jobs).toEqual([JOB]);
    expect(sleeps).toEqual([]);
    expect(requests[0]?.url).toBe("http://127.0.0.1:7070/api/host/poll");
    expect(requests[0]?.init?.headers).toMatchObject({
      authorization: "Bearer tok",
      [HOST_INFO_HEADER]: JSON.stringify(INFO),
    });
  });

  it("answers a job it does not understand instead of crashing", async () => {
    const { jobs, requests } = await runScript([
      json({ id: "j9", method: "format-disk", params: {} }),
      empty(),
    ]);
    expect(jobs).toEqual([]);
    const replyRequest = requests.find((r) => r.url.endsWith("/api/host/reply"));
    expect(JSON.parse(String(replyRequest?.init?.body))).toEqual({
      id: "j9",
      ok: false,
      error: 'This host helper cannot run "format-disk". Run `make up` to update it.',
    });
  });

  it("backs off while the server refuses the token", async () => {
    const denied = () =>
      new Response(JSON.stringify({ error: "Missing or wrong host token" }), { status: 401 });
    const { sleeps, logs } = await runScript([denied(), denied(), empty()]);
    expect(sleeps).toEqual([250, 500]);
    expect(logs[0]).toContain("refused the token");
  });
});
