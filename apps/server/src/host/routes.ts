import {
  type ApiError,
  HOST_INFO_HEADER,
  type HostInfo,
  HostInfoSchema,
  HostReplySchema,
} from "@majhi/shared";
import { Hono } from "hono";
import { formatIssues } from "../errors.ts";
import type { HostLink } from "./link.ts";
import { isHostAuthorized } from "./token.ts";

export interface HostRoutesDeps {
  link: HostLink;
  /** Holds `host.token`. */
  majhiHome: string;
}

/**
 * The host helper's endpoints, mounted at `/api/host`:
 * `POST /poll` answers 200 with a job or 204 when none came in time;
 * `POST /reply` takes the helper's answer to a job.
 */
export function hostRoutes({ link, majhiHome }: HostRoutesDeps): Hono {
  const app = new Hono();

  app.use("*", async (c, next) => {
    // Only the helper calls these, never a browser. Any page, even a local one, is refused.
    if (c.req.header("origin") !== undefined) {
      return c.json(
        { error: "The host helper endpoints do not accept browser requests" } satisfies ApiError,
        403,
      );
    }
    if (!(await isHostAuthorized(c.req.header("authorization"), majhiHome))) {
      return c.json({ error: "Missing or wrong host token" } satisfies ApiError, 401);
    }
    await next();
  });

  app.post("/poll", async (c) => {
    const info = parseInfo(c.req.header(HOST_INFO_HEADER));
    if (!info.ok) return c.json(info.error, 400);
    if (link.isClosed) {
      c.header("connection", "close");
      return c.json({ error: "majhi is stopping" } satisfies ApiError, 503);
    }
    const job = await link.poll(info.info, c.req.raw.signal);
    return job === undefined ? c.body(null, 204) : c.json(job);
  });

  app.post("/reply", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "The request body is not valid JSON" } satisfies ApiError, 400);
    }
    const reply = HostReplySchema.safeParse(body);
    if (!reply.success) {
      return c.json({ error: "Invalid reply", details: formatIssues(reply.error) } satisfies ApiError, 400);
    }
    // A reply to a job that already timed out has nobody waiting. That is fine.
    link.reply(reply.data);
    return c.body(null, 204);
  });

  return app;
}

function parseInfo(
  header: string | undefined,
): { ok: true; info: HostInfo } | { ok: false; error: ApiError } {
  let raw: unknown;
  try {
    raw = JSON.parse(header ?? "");
  } catch {
    return { ok: false, error: { error: `The ${HOST_INFO_HEADER} header is missing or not valid JSON` } };
  }
  const info = HostInfoSchema.safeParse(raw);
  if (!info.success) {
    return {
      ok: false,
      error: { error: `Invalid ${HOST_INFO_HEADER} header`, details: formatIssues(info.error) },
    };
  }
  return { ok: true, info: info.data };
}
