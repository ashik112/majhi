#!/usr/bin/env node
// The one process of a workspace's browser container (SPEC 4.5, "Browser container"). It runs after
// majhi-netguard has closed the container's reach to every private network, as the owner's uid.
//
// For each browser profile majhi gives it (MAJHI_BROWSER_PROFILES, a JSON list of {id, port, dir}) it
// listens on the profile's port. The first connection starts a headless Chromium on that profile's
// folder, on a loopback port of its own; later connections reuse it; a Chromium nobody has used for
// MAJHI_BROWSER_IDLE_MS is stopped, and when no profile has had a connection for MAJHI_BROWSER_EXIT_MS
// the whole container ends (it was started with --rm), so an idle workspace costs nothing.
//
// Chromium answers only to a Host header that is `localhost` or an IP address, and writes its own
// WebSocket address from the Host it was asked with. So the plain HTTP calls of CDP discovery
// (`/json/version`, `/json/list`) are answered by this proxy with the address the client used, and a
// WebSocket upgrade is passed on with `Host: localhost`. Nothing but CDP reaches Chromium.

import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";

const CHROMIUM = process.env.MAJHI_CHROMIUM ?? "/usr/local/bin/chromium";
const IDLE_BROWSER_MS = Number(process.env.MAJHI_BROWSER_IDLE_MS ?? 5 * 60_000);
const IDLE_EXIT_MS = Number(process.env.MAJHI_BROWSER_EXIT_MS ?? 15 * 60_000);
const START_WAIT_MS = 20_000;
const SWEEP_MS = 15_000;

/** The profiles, checked: each has an id, a port of 1024 to 65535 and an absolute folder. */
export function parseProfiles(text) {
  const list = JSON.parse(text ?? "[]");
  if (!Array.isArray(list) || list.length === 0) throw new Error("MAJHI_BROWSER_PROFILES holds no profile");
  return list.map((p) => {
    if (typeof p?.id !== "string" || !Number.isInteger(p?.port) || p.port < 1024 || p.port > 65535)
      throw new Error("a browser profile needs an id and a port");
    if (typeof p.dir !== "string" || !p.dir.startsWith("/"))
      throw new Error(`${p.id} has no absolute folder`);
    return { id: p.id, port: p.port, dir: p.dir, local: p.port + 1000 };
  });
}

/** `localhost:<local>` and `127.0.0.1:<local>` in a CDP answer become the address the client used. */
export function rewriteDiscovery(body, local, publicHost) {
  return body.split(`localhost:${local}`).join(publicHost).split(`127.0.0.1:${local}`).join(publicHost);
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
        if (Date.now() > until) reject(new Error(`Chromium did not open port ${port}`));
        else setTimeout(attempt, 150);
      });
    };
    attempt();
  });
}

function main() {
  const profiles = parseProfiles(process.env.MAJHI_BROWSER_PROFILES);
  let lastAny = Date.now();
  const state = new Map(
    profiles.map((p) => [p.id, { proc: undefined, starting: undefined, active: 0, last: Date.now() }]),
  );

  const stop = (p) => {
    const s = state.get(p.id);
    if (s.proc !== undefined) s.proc.kill("SIGTERM");
    s.proc = undefined;
    s.starting = undefined;
  };

  const ensure = (p) => {
    const s = state.get(p.id);
    if (s.proc !== undefined && s.starting !== undefined) return s.starting;
    const proc = spawn(
      CHROMIUM,
      [
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--remote-debugging-address=127.0.0.1",
        `--remote-debugging-port=${p.local}`,
        `--user-data-dir=${p.dir}`,
        "about:blank",
      ],
      {
        stdio: "ignore",
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/tmp", LANG: process.env.LANG ?? "C.UTF-8" },
      },
    );
    s.proc = proc;
    proc.once("exit", () => {
      if (s.proc === proc) {
        s.proc = undefined;
        s.starting = undefined;
      }
    });
    s.starting = waitForPort(p.local, START_WAIT_MS).catch((err) => {
      stop(p);
      throw err;
    });
    return s.starting;
  };

  const touch = (p, delta) => {
    const s = state.get(p.id);
    s.active += delta;
    s.last = lastAny = Date.now();
  };

  for (const p of profiles) {
    const server = http.createServer(async (req, res) => {
      touch(p, 1);
      try {
        await ensure(p);
        const publicHost = req.headers.host ?? `localhost:${p.port}`;
        const upstream = http.request(
          {
            host: "127.0.0.1",
            port: p.local,
            path: req.url,
            method: req.method,
            headers: { host: `localhost:${p.local}` },
          },
          (answer) => {
            const chunks = [];
            answer.on("data", (c) => chunks.push(c));
            answer.on("end", () => {
              const body = rewriteDiscovery(Buffer.concat(chunks).toString("utf8"), p.local, publicHost);
              const headers = { ...answer.headers, "content-length": Buffer.byteLength(body) };
              res.writeHead(answer.statusCode ?? 502, headers);
              res.end(body);
              touch(p, -1);
            });
          },
        );
        upstream.on("error", () => {
          res.writeHead(502).end();
          touch(p, -1);
        });
        upstream.end();
      } catch {
        res.writeHead(502).end();
        touch(p, -1);
      }
    });
    server.on("upgrade", async (req, socket, head) => {
      touch(p, 1);
      let closed = false;
      const done = () => {
        if (closed) return;
        closed = true;
        touch(p, -1);
      };
      socket.on("close", done);
      socket.on("error", () => socket.destroy());
      try {
        await ensure(p);
      } catch {
        socket.destroy();
        return;
      }
      const upstream = net.connect(p.local, "127.0.0.1");
      upstream.on("error", () => socket.destroy());
      upstream.on("close", () => socket.destroy());
      upstream.on("connect", () => {
        const lines = [`${req.method} ${req.url} HTTP/1.1`];
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
          const name = req.rawHeaders[i];
          lines.push(
            `${name}: ${name.toLowerCase() === "host" ? `localhost:${p.local}` : req.rawHeaders[i + 1]}`,
          );
        }
        upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
        if (head.length > 0) upstream.write(head);
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
    });
    server.listen(p.port, "0.0.0.0");
  }

  setInterval(() => {
    const now = Date.now();
    for (const p of profiles) {
      const s = state.get(p.id);
      if (s.proc !== undefined && s.active === 0 && now - s.last > IDLE_BROWSER_MS) stop(p);
    }
    const running = profiles.some((p) => state.get(p.id).proc !== undefined);
    const busy = profiles.some((p) => state.get(p.id).active > 0);
    if (!running && !busy && now - lastAny > IDLE_EXIT_MS) process.exit(0);
  }, SWEEP_MS);
  process.on("SIGTERM", () => {
    for (const p of profiles) stop(p);
    process.exit(0);
  });
  console.log("majhi-browserd ready");
}

if (import.meta.url === `file://${process.argv[1]}`) main();
