import { Hono } from "hono";
import type { ConnectService } from "./service.ts";

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The page the owner lands on after the service's own page. Plain text from majhi, nothing from the request. */
function page(ok: boolean, message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>majhi</title><style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,sans-serif;background:Canvas;color:CanvasText}
main{max-width:30rem;padding:2rem}
h1{font-size:1.25rem;margin:0 0 .5rem}
p{margin:0;opacity:.8}
</style></head><body><main><h1>${ok ? "You can close this tab" : "Not connected"}</h1><p>${escapeHtml(message)}</p></main></body></html>`;
}

/** `GET /oauth/callback`: where a service sends the owner back after the consent page. */
export function connectRoutes(connect: ConnectService): Hono {
  const app = new Hono();
  app.get("/oauth/callback", async (c) => {
    const url = new URL(c.req.url);
    const result = await connect.callback(url.searchParams);
    c.header("cache-control", "no-store");
    c.header("referrer-policy", "no-referrer");
    c.header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'");
    return c.html(page(result.ok, result.message), result.ok ? 200 : 400);
  });
  return app;
}
