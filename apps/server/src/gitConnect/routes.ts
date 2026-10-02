import { type BitbucketCallbackQuery, BitbucketCallbackQuerySchema } from "@majhi/shared";
import { Hono } from "hono";

export interface OAuthRoutesDeps {
  /**
   * Ends the Bitbucket sign-in flow whose one-time `state` this is: exchanges `code` for tokens with
   * the consumer key and secret, checks the user, saves the token for the flow's workspace. Answers
   * one plain sentence for the page. Never puts the code or a token in the page or a log.
   */
  bitbucketCallback(query: BitbucketCallbackQuery): Promise<{ ok: boolean; message: string }>;
}

/**
 * `GET /oauth/bitbucket/callback`, where Bitbucket sends the browser back after the owner allowed
 * majhi. Not under `/api`: the browser arrives from bitbucket.org, so there is no loopback Origin
 * to check. The single-use `state` of a pending flow is the check. Without deps it answers 501.
 */
export function oauthRoutes(deps: OAuthRoutesDeps | undefined): Hono {
  const app = new Hono();
  app.get("/bitbucket/callback", async (c) => {
    const query = BitbucketCallbackQuerySchema.safeParse(c.req.query());
    if (!query.success) return c.html(page("This sign-in link is not complete. Start again in majhi."), 400);
    if (deps === undefined) return c.html(page("Bitbucket sign-in is not built yet."), 501);
    const result = await deps.bitbucketCallback(query.data);
    return c.html(page(result.message), result.ok ? 200 : 400);
  });
  return app;
}

/** A tiny page with one sentence. The sentence is escaped; it never holds the code or a token. */
function page(message: string): string {
  const text = message.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  return `<!doctype html><meta charset="utf-8"><title>majhi</title><p>${text}</p><p>You can close this tab and go back to majhi.</p>`;
}
