#!/usr/bin/env node
// The `docker` of a runner container. A runner has no Docker and never gets the socket. Scripts that
// call `docker run` (a repo's hand-off check, a test) reach this task's own containers through majhi:
// the arguments go to MAJHI_DOCKER_URL with the run's token, majhi checks them and runs them, and the
// exit code and output come back here. Source: apps/server/src/containers/task-docker.ts.

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
  process.stderr.write("Usage: docker run | build | exec | logs | ps | rm | stop | start | wait | inspect\n");
  process.exit(1);
}

try {
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ argv, cwd: process.cwd() }),
  });
  if (!res.ok) {
    process.stderr.write(`docker: majhi answered ${res.status}. This run may not use docker now.\n`);
    process.exit(1);
  }
  const out = await res.json();
  if (out.stdout) process.stdout.write(out.stdout);
  if (out.stderr) process.stderr.write(out.stderr);
  process.exitCode = Number.isInteger(out.code) ? out.code : 1;
} catch (err) {
  process.stderr.write(
    `docker: could not reach majhi (${err instanceof Error ? err.message : String(err)}).\n`,
  );
  process.exit(1);
}
