import { PHONE_ACTIONS, PHONE_LINK_REFUSED } from "@majhi/shared";
import { Hono } from "hono";
import type { PhoneChannel } from "./phone.ts";

/**
 * The links behind the phone's buttons: `/ops/phone/<ref>/<action>?t=<token>`. The reference is random and
 * names no decision; the token is the only credential. A GET only shows a page with a button (mail scanners and link previews open links);
 * the POST spends the token. majhi is not on the internet, so these answer only a phone that can reach
 * it. Too many wrong tries and the route stops answering for a while.
 */

const WINDOW_MS = 10 * 60_000;
const MAX_REFUSED = 20;

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function page(title: string, body: string, form?: { action: string; label: string }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title><style>body{font:16px system-ui,sans-serif;margin:2rem auto;max-width:22rem;padding:0 1rem}button{font:inherit;padding:.7rem 1.4rem}</style></head><body><h1 style="font-size:1.2rem">${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p>${
    form === undefined
      ? ""
      : `<form method="post" action="${escapeHtml(form.action)}"><button type="submit">${escapeHtml(form.label)}</button></form>`
  }</body></html>`;
}

const LABEL: Record<string, string> = { approve: "Approve", leave: "Leave", ack: "Acknowledge" };

export function opsPhoneRoutes(deps: { phone: PhoneChannel; now?: () => number }): Hono {
  const app = new Hono();
  const refused: number[] = [];
  const now = () => deps.now?.() ?? Date.now();
  const limited = (): boolean => {
    const cutoff = now() - WINDOW_MS;
    while (refused.length > 0 && (refused[0] ?? 0) < cutoff) refused.shift();
    return refused.length >= MAX_REFUSED;
  };
  const headers = { "cache-control": "no-store", "referrer-policy": "no-referrer" };

  app.get("/ops/phone/:ref/:action", (c) => {
    const action = c.req.param("action");
    if (!(PHONE_ACTIONS as readonly string[]).includes(action))
      return c.text(PHONE_LINK_REFUSED, 404, headers);
    const url = new URL(c.req.url);
    return c.html(
      page("majhi", `${LABEL[action] ?? "Confirm"} this?`, {
        action: `${url.pathname}${url.search}`,
        label: LABEL[action] ?? "Confirm",
      }),
      200,
      headers,
    );
  });

  app.post("/ops/phone/:ref/:action", async (c) => {
    const action = c.req.param("action");
    const token = c.req.query("t") ?? "";
    if (!(PHONE_ACTIONS as readonly string[]).includes(action) || token === "") {
      return c.text(PHONE_LINK_REFUSED, 404, headers);
    }
    if (limited()) return c.text(PHONE_LINK_REFUSED, 429, headers);
    const res = await deps.phone.act(c.req.param("ref"), action, token);
    if (!res.ok) refused.push(now());
    return c.text(res.text, res.ok ? 200 : 403, headers);
  });

  return app;
}
