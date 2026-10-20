// Codex's PreToolUse hook in a runner, installed as /etc/codex/hooks/majhi-pretool.mjs and listed in
// /etc/codex/requirements.toml. Codex runs it before every tool call, with the call as JSON on stdin. It sends
// the JSON to majhi (MAJHI_HOOK_URL, with the session's token in MAJHI_HOOK_TOKEN), which decides the way it does
// for any agent's permission request (apps/server/src/runs/codex-hook.ts), and prints majhi's answer.
//
// Codex lets a call run when its hook crashes, exits with another code than 0 or 2, or runs past its `timeout`.
// So this script never lets one of those happen: every path ends in one of two outputs, and only an answer of
// "allow" from majhi prints the first.
//   allow  nothing on stdout, exit 0.
//   deny   a PreToolUse decision of "deny" with a plain reason for the agent, exit 0.
// Node built-ins only and one HTTP call: this runs before every command.

import http from "node:http";
import https from "node:https";

/** Shorter than the `timeout` of requirements.toml (3600 s) by what Node's start and the stdin write may take. */
const DEADLINE_MS = 3_585_000;
const WAITING = "Waiting for the owner's answer in majhi.";
const MAX_REPLY_BYTES = 64 * 1024;
const MAX_REASON_CHARS = 1_000;

// `MAJHI_HOOK_DEADLINE_MS` can only make the wait shorter (tests use it).
const asked = Number(process.env.MAJHI_HOOK_DEADLINE_MS);
const deadlineMs = Number.isFinite(asked) && asked > 0 ? Math.min(asked, DEADLINE_MS) : DEADLINE_MS;

let finished = false;
let waitingForOwner = false;

function finish(decision, reason) {
  if (finished) return;
  finished = true;
  const out =
    decision === "allow"
      ? ""
      : JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: String(reason).slice(0, MAX_REASON_CHARS),
          },
        });
  // The write ends the run, so a reader never sees half of the line.
  process.stdout.write(out, () => process.exit(0));
}

const deny = (reason) => finish("deny", reason);

process.on("uncaughtException", (err) =>
  deny(`The majhi hook failed (${err?.message ?? err}), so the call did not run.`),
);
process.on("unhandledRejection", (err) =>
  deny(`The majhi hook failed (${err?.message ?? err}), so the call did not run.`),
);
setTimeout(
  () => deny(waitingForOwner ? WAITING : "majhi did not answer in time, so the call did not run."),
  deadlineMs,
);

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

function post(target, token, body) {
  return new Promise((resolve, reject) => {
    const request = (target.protocol === "https:" ? https : http).request(
      target,
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
        let size = 0;
        res.on("data", (c) => {
          size += c.length;
          if (size > MAX_REPLY_BYTES) {
            request.destroy(new Error("majhi's answer was too long"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }),
        );
        res.on("error", reject);
      },
    );
    // A question can wait for the owner for a long time: keep the connection from being dropped while idle.
    request.on("socket", (socket) => socket.setKeepAlive(true, 30_000));
    request.on("error", reject);
    request.end(body);
  });
}

try {
  const url = process.env.MAJHI_HOOK_URL;
  const token = process.env.MAJHI_HOOK_TOKEN;
  if (!url || !token) {
    deny("This Codex session has no way to ask majhi, so the call did not run.");
  } else {
    const body = await readStdin();
    if (body.trim() === "") {
      deny("Codex sent no call to check, so it did not run.");
    } else {
      waitingForOwner = true;
      const res = await post(new URL(url), token, body);
      waitingForOwner = false;
      let reply;
      try {
        reply = JSON.parse(res.text);
      } catch {
        reply = undefined;
      }
      if (res.status === 200 && reply?.decision === "allow") finish("allow");
      else if (res.status === 200 && reply?.decision === "deny") {
        deny(
          typeof reply.reason === "string" && reply.reason !== ""
            ? reply.reason
            : "majhi did not allow this call.",
        );
      } else
        deny(`majhi answered ${res.status} with something the hook cannot use, so the call did not run.`);
    }
  }
} catch (err) {
  deny(`The hook could not reach majhi (${err?.message ?? err}), so the call did not run.`);
}
