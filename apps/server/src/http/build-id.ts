import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The id of the web bundle this server serves: the `majhi-build` meta tag the web build writes into
 * index.html (a hash of the hashed names of every emitted file). Undefined when there is no bundle
 * (dev, tests) or it carries no id.
 */
export function readBuildId(webDist: string): string | undefined {
  try {
    const html = readFileSync(join(webDist, "index.html"), "utf8");
    return /<meta\s+name="majhi-build"\s+content="([A-Za-z0-9_-]{1,64})"/.exec(html)?.[1];
  } catch {
    return undefined;
  }
}
