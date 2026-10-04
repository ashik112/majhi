import type { ConnectionConfig } from "@majhi/shared";
import { describe, expect, it } from "vitest";
import { readApi } from "./tester.ts";

const doConn: ConnectionConfig = {
  type: "mcp",
  name: "DigitalOcean",
  fields: { transport: "remote", url: "https://accounts.mcp.digitalocean.com/mcp", auth: "oauth" },
};

describe("a watch's read of a service API with the connection's sign-in", () => {
  it("sends the token only to the service's own API host, with the window at this look", async () => {
    const asked: { url: string; auth: string | null }[] = [];
    const fetchFn = (async (url: URL, init: RequestInit) => {
      asked.push({ url: url.toString(), auth: new Headers(init.headers).get("authorization") });
      return new Response(
        JSON.stringify({
          data: {
            result: [
              {
                values: [
                  [1, "0.4"],
                  [2, "0.9"],
                ],
              },
            ],
          },
        }),
      );
    }) as unknown as typeof fetch;
    const answer = await readApi(
      doConn,
      "https://api.digitalocean.com/v2/monitoring/metrics/droplet/load_1",
      { host_id: "42", start: "{{minutesAgo:5}}", end: "{{now}}" },
      "tok",
      5000,
      () => 1_000_000_000,
      fetchFn,
    );
    expect(asked).toEqual([
      {
        url: "https://api.digitalocean.com/v2/monitoring/metrics/droplet/load_1?host_id=42&start=999700&end=1000000",
        auth: "Bearer tok",
      },
    ]);
    expect(answer).toMatchObject({
      data: {
        result: [
          {
            values: [
              [1, "0.4"],
              [2, "0.9"],
            ],
          },
        ],
      },
    });

    await expect(
      readApi(doConn, "https://evil.example/steal", {}, "tok", 5000, Date.now, fetchFn),
    ).rejects.toThrow("only goes to api.digitalocean.com");
    await expect(
      readApi(doConn, "http://api.digitalocean.com/v2/account", {}, "tok", 5000, Date.now, fetchFn),
    ).rejects.toThrow("only goes to");
    expect(asked).toHaveLength(1);
  });
});
