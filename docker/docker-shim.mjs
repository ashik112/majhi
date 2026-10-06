#!/usr/bin/env node
// The `docker` of a runner container. A runner has no Docker and never gets the socket. Scripts that
// call `docker run` (a repo's hand-off check, a test) reach this task's own containers through majhi:
// the arguments go to MAJHI_DOCKER_URL with the run's token, majhi checks them and runs them, and the
// exit code and output come back here. A refusal prints `docker: [code] message`, and the reply's `error.code`
// carries the same code. Source: apps/server/src/containers/task-docker.ts and compose.ts.

import http from "node:http";
import https from "node:https";

const url = process.env.MAJHI_DOCKER_URL;
const token = process.env.MAJHI_DOCKER_TOKEN;
const argv = process.argv.slice(2);

if (argv[0] === "--version" || argv[0] === "-v") {
  process.stdout.write("Docker version majhi (the containers of this task, through majhi)\n");
  process.exit(0);
}
if (url === undefined || token === undefined) {
  process.stderr.write("docker is not available in this run: majhi cannot run containers here.\n");
  process.exit(1);
}
if (argv.length === 0) {
  process.stderr.write(
    "Usage: docker run | build | exec | logs | ps | rm | stop | start | wait | inspect | compose up|down|ps|logs|exec\n",
  );
  process.exit(1);
}

// node:http, not fetch: a `docker compose up` that pulls images or waits for a database can take longer
// than the five minutes fetch waits for the first byte of a reply.
function post(target, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(target);
    const request = (u.protocol === "https:" ? https : http).request(
      u,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }),
        );
        res.on("error", reject);
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

try {
  const res = await post(url, JSON.stringify({ argv, cwd: process.cwd() }));
  if (res.status < 200 || res.status > 299) {
    process.stderr.write(`docker: majhi answered ${res.status}. This run may not use docker now.\n`);
    process.exit(1);
  }
  const out = JSON.parse(res.text);
  if (out.stdout) process.stdout.write(out.stdout);
  if (out.stderr) process.stderr.write(out.stderr);
  process.exitCode = Number.isInteger(out.code) ? out.code : 1;
} catch (err) {
  process.stderr.write(
    `docker: could not reach majhi (${err instanceof Error ? err.message : String(err)}).\n`,
  );
  process.exit(1);
}
