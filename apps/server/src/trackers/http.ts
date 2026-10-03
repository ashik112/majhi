import { type TrackerItem, TrackerItemSchema } from "@majhi/shared";
import type { z } from "zod";
import { scrub } from "../mrs/hosts/types.ts";
import { type TrackerAdapterInit, TrackerError } from "./types.ts";

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_MESSAGE = 300;

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH";
  /** Sent as JSON. */
  body?: unknown;
  headers?: Record<string, string>;
  /** Other secrets to remove from messages, like the encoded form of the token in a Basic header. */
  secrets?: string[];
}

/**
 * One JSON call to a tracker. Times out after 20 s. A non-2xx answer or a network failure becomes
 * a TrackerError with a short message from the body, and the token is removed from every message.
 * Returns the parsed JSON, or `undefined` for an empty body.
 */
export async function request(
  init: TrackerAdapterInit,
  url: string,
  options: RequestOptions = {},
): Promise<unknown> {
  const { method = "GET", body, headers = {}, secrets = [] } = options;
  const clean = (text: string): string => [init.token, ...secrets].reduce((t, s) => scrub(t, s), text);
  const host = new URL(url).host;
  const requestHeaders: Record<string, string> = { ...headers };
  if (body !== undefined) requestHeaders["Content-Type"] = "application/json";

  let res: Response;
  let text: string;
  try {
    res = await init.fetch(url, {
      method,
      headers: requestHeaders,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    text = await res.text();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new TrackerError(clean(`Could not reach ${host}: ${reason}`));
  }

  let data: unknown;
  if (text.trim() !== "") {
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
      if (res.ok) throw new TrackerError(`${host} answered with something that is not JSON.`, res.status);
    }
  }
  if (!res.ok) {
    // Scrub before cutting, so a cut cannot leave half of the token behind.
    const detail = clip(clean(messageFrom(data)), MAX_MESSAGE);
    throw new TrackerError(
      clean(`${host} answered ${res.status}${detail === "" ? "" : `: ${detail}`}`),
      res.status,
    );
  }
  return data;
}

/** Checks a response against its schema, so a changed API shows up as one clear error. */
export function parse<S extends z.ZodType>(schema: S, data: unknown, what: string): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) throw new TrackerError(`The tracker's answer for ${what} was not what majhi expects.`);
  return result.data;
}

/** The short reason in an error body: Jira `errorMessages` and `errors`, ClickUp `err`, GitHub `message`. */
function messageFrom(data: unknown): string {
  if (typeof data !== "object" || data === null) return "";
  const body = data as Record<string, unknown>;
  const parts: string[] = [];
  if (Array.isArray(body.errorMessages))
    parts.push(...body.errorMessages.filter((m) => typeof m === "string"));
  if (typeof body.errors === "object" && body.errors !== null && !Array.isArray(body.errors)) {
    parts.push(...Object.values(body.errors).filter((m) => typeof m === "string"));
  }
  if (typeof body.err === "string") parts.push(body.err);
  if (typeof body.message === "string") parts.push(body.message);
  return parts.join(" ");
}

/** Cuts text to at most `max` characters, ending in `...` when it was cut. */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`;
}

/** Fits an item into the limits of `TrackerItemSchema`: long text is cut, and the url must be valid. */
export function fitItem(item: TrackerItem): TrackerItem {
  return parse(
    TrackerItemSchema,
    {
      ...item,
      key: clip(item.key, 200),
      title: clip(item.title, 1000),
      body: clip(item.body, 200_000),
      status: clip(item.status, 200),
      assignee: item.assignee === undefined ? undefined : clip(item.assignee, 200),
      labels: item.labels.slice(0, 100).map((label) => clip(label, 200)),
    },
    `item ${item.key}`,
  );
}

/** A time from a tracker as ISO text. Falls back to the text itself when it is not a time. */
export function isoTime(value: string | number): string {
  const text = typeof value === "string" ? value.replace(/([+-]\d\d)(\d\d)$/, "$1:$2") : value;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}
