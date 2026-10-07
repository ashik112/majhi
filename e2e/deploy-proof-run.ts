/**
 * Proves deploys end to end on the isolated majhi of `deploy-proof.ts`: a staging deploy that verifies, a
 * failing one that rolls back and opens an incident, and production waiting for the owner, then deploying on
 * the click (an ssh command on the throwaway container). Prints what it saw and exits non-zero on a miss.
 *
 *   MAJHI_E2E_PORT=7191 node --import tsx e2e/deploy-proof-run.ts
 */
import { cmd, startProof } from "./deploy-proof.ts";
import { prepare, until } from "./deploy-proof-flow.ts";

const proof = await startProof();
const { url, hosts } = proof;
const say = (text: string) => console.log(`- ${text}`);
const check = (ok: boolean, text: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${text}`);
  if (!ok) process.exitCode = 1;
};

try {
  say("setting up watches, targets and the captain's rules");
  const { makeTask, landed } = await prepare(proof);

  // 1. A merged fix deploys to staging by the rule, is checked, and goes live.
  say("task 1: a bug fix, merged, deployed to staging by the rule");
  const one = await makeTask("Checkout fails when a coupon takes more than 50% off", "coupon.txt");
  const landed1 = await until("the fix to land", () => landed(one));
  proof.push(landed1.commit);
  // The Push step: now the host has the commit, the captain looks again.
  proof.majhi.services.captain.deployChanged("acme");
  check(true, `landed in ${landed1.commit.slice(0, 7)}, pushed to the fake host`);
  const live1 = await until("staging to go live", async () => {
    const h = (await cmd(url, "projects.deployView", { project: "storefront" })).history;
    return h.find((r: { env: string; state: string }) => r.env === "staging" && r.state === "live");
  });
  check(
    live1.commit === landed1.commit && live1.by === "captain",
    `staging live at ${live1.commit.slice(0, 7)} by the captain, check: ${live1.check?.detail}`,
  );
  const detail1 = await until("production to wait for the owner", async () => {
    const d = await cmd(url, "tasks.detail", { id: one });
    return d.deployAsk === undefined ? undefined : d;
  });
  check(
    detail1.deployAsk.env === "production" && detail1.deployAsk.after === "staging",
    `the task asks "Deploy to production?" after staging at ${detail1.deployAsk.commit.slice(0, 7)}`,
  );
  const prodBefore = (await cmd(url, "projects.deployView", { project: "storefront" })).history.filter(
    (r: { env: string }) => r.env === "production",
  );
  check(prodBefore.length === 0, "production did not deploy by itself");

  // 2. The owner clicks Deploy production: the ssh command runs on the container and the check passes.
  say("production: the owner's click");
  const click = await cmd(url, "projects.deploy", {
    project: "storefront",
    env: "production",
    task: one,
    commit: landed1.commit,
  });
  check(click.repeat === false, "the click started the deploy");
  const prod = await until("production to go live", async () => {
    const h = (await cmd(url, "projects.deployView", { project: "storefront" })).history;
    return h.find(
      (r: { env: string; state: string }) =>
        r.env === "production" && (r.state === "live" || r.state === "failed"),
    );
  });
  check(
    prod.state === "live" && prod.by === "owner",
    `production ${prod.state} (ssh command ran on the host: RELEASE=${(await proof.onHost("tail -1 /srv/storefront/RELEASE")).split("\n")[0]})`,
  );
  const again = await cmd(url, "projects.deploy", {
    project: "storefront",
    env: "production",
    task: one,
    commit: landed1.commit,
  });
  check(
    again.repeat === true && again.record.id === prod.id,
    "asking again for the same target and commit started nothing",
  );

  // 3. A second fix whose deploy fails: it rolls back to the first and opens an incident.
  say("task 2: a fix whose staging deploy fails");
  hosts.outcome.github = "failure";
  const two = await makeTask("Invoice footer shows the wrong tax", "tax.txt");
  const landed2 = await until("the second fix to land", () => landed(two));
  proof.push(landed2.commit);
  proof.majhi.services.captain.deployChanged("acme");
  const failed = await until("staging to fail and roll back", async () => {
    const h = (await cmd(url, "projects.deployView", { project: "storefront" })).history;
    return h.find(
      (r: { env: string; commit: string; incident?: string }) =>
        r.env === "staging" && r.commit === landed2.commit && r.incident !== undefined,
    );
  });
  hosts.outcome.github = "success";
  check(
    failed.state === "rolled-back" && failed.rollback?.commit === landed1.commit,
    `staging ${failed.state}, rolled back to ${failed.rollback?.commit?.slice(0, 7)}: ${failed.reason}`,
  );
  const incident = failed.incident as string | undefined;
  const task = incident === undefined ? undefined : await cmd(url, "tasks.get", { id: incident });
  check(
    task?.typing?.type === "incident" && task?.origin?.kind === "deploy",
    `incident ${incident} opened (type ${task?.typing?.type}, origin ${task?.origin?.kind})`,
  );
  const prodGuard = await cmd(url, "projects.deploy", {
    project: "storefront",
    env: "production",
    commit: landed2.commit,
  }).then(
    () => "started",
    (e: Error) => e.message,
  );
  check(
    prodGuard.includes("staging is not live"),
    `production refuses while staging is not live: ${prodGuard.slice(0, 120)}`,
  );
  const log = await cmd(url, "captain.log", { limit: 20 }).catch(() => undefined);
  const lines = (log?.actions ?? []).map(
    (a: { text: string; undoWord?: string }) => `${a.text}${a.undoWord === undefined ? "" : " [Roll back]"}`,
  );
  say(`captain log: ${lines.slice(0, 6).join(" | ")}`);
  if (process.argv.includes("--hold")) {
    say(`holding: ${url} (fake hosts ${hosts.url}); Ctrl-C to stop`);
    await new Promise(() => undefined);
  }
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  if (!process.argv.includes("--hold")) {
    await proof.stop();
    process.exit(process.exitCode ?? 0);
  }
}
