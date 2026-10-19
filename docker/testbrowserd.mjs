#!/usr/bin/env node
// The one process of a workspace's test browser (SPEC 4.5, "Test browser"). It runs after majhi-netguard has
// closed the container's reach to every private network, as the owner's uid.
//
// A repo's own `playwright test` connects here (through majhi's authenticated proxy, never directly) to get
// Chromium. Playwright's server and its client must be the same major.minor version, and the client says which
// it is in the User-Agent of its WebSocket upgrade (`Playwright/1.63.0 ...`). So this process starts a
// `playwright-core run-server` of that exact version on a loopback port, on the first connection, and passes the
// upgrade on to it:
//   - the version installed with the image (its Chromium is in PLAYWRIGHT_BROWSERS_PATH) starts at once;
//   - any other version is installed first, with its Chromium, into /tmp (public internet only), then started.
// A server nobody has used for MAJHI_TESTBROWSER_IDLE_MS is stopped, and when nothing has connected for
// MAJHI_TESTBROWSER_EXIT_MS the whole container ends (it was started with --rm), so an idle workspace costs nothing.
// Only Chromium is installed: a test that asks for Firefox or WebKit gets Playwright's own "not installed" error.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { pathToFileURL } from "node:url";

const PORT = Number(process.env.MAJHI_TESTBROWSER_PORT ?? 3000);
const GLOBAL_CORE = "/usr/local/lib/node_modules/playwright-core";
/** The version installed with the image, read from the package: the image has one pin, here it is not repeated. */
const BAKED = (() => {
  try {
    return JSON.parse(readFileSync(`${GLOBAL_CORE}/package.json`, "utf8")).version ?? "";
  } catch {
    return "";
  }
})();
const BAKED_BROWSERS = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";
const IDLE_SERVER_MS = Number(process.env.MAJHI_TESTBROWSER_IDLE_MS ?? 5 * 60_000);
const IDLE_EXIT_MS = Number(process.env.MAJHI_TESTBROWSER_EXIT_MS ?? 15 * 60_000);
const START_WAIT_MS = 180_000;
const SWEEP_MS = 15_000;
const BASE_PORT = 3100;
const ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/tmp", LANG: process.env.LANG ?? "C.UTF-8" };

/** The client's version from its User-Agent (`Playwright/1.63.0 (...)`), or undefined when it is not one. */
export function clientVersion(userAgent) {
  if (typeof userAgent !== "string" || !userAgent.startsWith("Playwright/")) return undefined;
  const version = userAgent.slice("Playwright/".length).split(" ")[0] ?? "";
  const parts = version.split(".");
  return parts.length === 3 &&
    parts.every((p) => p !== "" && Number.isInteger(Number(p)) && String(Number(p)) === p)
    ? version
    : undefined;
}

function run(command, args, env, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, cwd, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    child.stderr.on("data", (d) => {
      if (err.length < 2000) err += d;
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(err.trim().split("\n").pop() || `exit ${code}`)),
    );
  });
}

function waitForPort(port, ms) {
  const until = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() > until) reject(new Error(`the Playwright server did not open port ${port}`));
        else setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}

function main() {
  /** version -> { port, proc, ready, active, last } */
  const servers = new Map();
  let lastAny = Date.now();
  let nextPort = BASE_PORT;

  const stop = (version) => {
    const s = servers.get(version);
    if (s === undefined) return;
    servers.delete(version);
    s.proc?.kill("SIGTERM");
  };

  const start = (version) => {
    const existing = servers.get(version);
    if (existing !== undefined) return existing;
    const baked = version === BAKED;
    const dir = baked ? undefined : `/tmp/pw/${version}`;
    const browsers = baked ? BAKED_BROWSERS : "/tmp/pw-browsers";
    const cli = baked ? `${GLOBAL_CORE}/cli.js` : `${dir}/node_modules/playwright-core/cli.js`;
    const entry = { port: nextPort++, proc: undefined, ready: undefined, active: 0, last: Date.now() };
    servers.set(version, entry);
    const env = { ...ENV, PLAYWRIGHT_BROWSERS_PATH: browsers };
    entry.ready = (async () => {
      if (!baked) {
        await run(
          "npm",
          ["install", "--prefix", dir, "--no-audit", "--no-fund", `playwright-core@${version}`],
          env,
          "/tmp",
        );
        await run("node", [cli, "install", "chromium"], env, "/tmp");
      }
      entry.proc = spawn("node", [cli, "run-server", "--port", String(entry.port), "--host", "127.0.0.1"], {
        env,
        stdio: "ignore",
      });
      entry.proc.once("exit", () => {
        if (servers.get(version) === entry) servers.delete(version);
      });
      await waitForPort(entry.port, START_WAIT_MS);
    })().catch((err) => {
      stop(version);
      throw err;
    });
    return entry;
  };

  const server = http.createServer((_req, res) => res.writeHead(404).end());
  server.on("upgrade", async (req, socket, head) => {
    lastAny = Date.now();
    socket.on("error", () => socket.destroy());
    const version = clientVersion(req.headers["user-agent"]);
    if (version === undefined) {
      socket.end(
        "HTTP/1.1 400 Bad Request\r\n\r\nThis is a Playwright server; the client did not say its version.\r\n",
      );
      return;
    }
    const entry = start(version);
    entry.active += 1;
    let counted = true;
    const done = () => {
      if (!counted) return;
      counted = false;
      entry.active -= 1;
      entry.last = lastAny = Date.now();
    };
    socket.on("close", done);
    try {
      await entry.ready;
    } catch (err) {
      console.error(`could not start Playwright ${version}: ${err.message}`);
      socket.end(
        "HTTP/1.1 502 Bad Gateway\r\n\r\nThe test browser could not start that Playwright version.\r\n",
      );
      return;
    }
    const upstream = net.connect(entry.port, "127.0.0.1");
    upstream.on("error", () => socket.destroy());
    upstream.on("close", () => socket.destroy());
    upstream.on("connect", () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2)
        lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
  });
  server.listen(PORT, "0.0.0.0");

  setInterval(() => {
    const now = Date.now();
    for (const [version, s] of servers)
      if (s.active === 0 && s.proc !== undefined && now - s.last > IDLE_SERVER_MS) stop(version);
    const busy = [...servers.values()].some((s) => s.active > 0);
    if (servers.size === 0 && !busy && now - lastAny > IDLE_EXIT_MS) process.exit(0);
  }, SWEEP_MS);
  process.on("SIGTERM", () => {
    for (const version of [...servers.keys()]) stop(version);
    process.exit(0);
  });
  console.log("majhi-testbrowserd ready");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
