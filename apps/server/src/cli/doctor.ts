import { HostStatusSchema } from "@majhi/shared";
import { loadConfig } from "../config/load.ts";
import type { ServerEnv } from "../env.ts";
import { type Check, collectChecks, type HostSource } from "../health/checks.ts";
import { createServices, type Services } from "../services.ts";
import { probeHosts, sshTargets } from "../ssh/hosts.ts";

export { type Check, type CheckStatus, checkSshAgent, sshVerdict } from "../health/checks.ts";

const HOST_STATUS_TIMEOUT_MS = 3_000;

/** `make doctor`: every check, run inside the container. The same checks back `health.run`. */
export async function runDoctor(env: ServerEnv, services: Services = createServices(env)): Promise<Check[]> {
  const config = await loadConfig(env);
  return collectChecks({
    env,
    services,
    config,
    host: await fetchHostStatus(env.port),
    sshHosts: async () => probeHosts(await sshTargets(config.projectPaths)),
    accounts: "probe",
  });
}

export function formatChecks(checks: readonly Check[]): string {
  const width = Math.max(...checks.map((c) => c.name.length));
  const rows = checks.map((c) => `${c.status.toUpperCase()}  ${c.name.padEnd(width)}  ${c.detail}`);
  const failed = checks.filter((c) => c.status === "fail").length;
  const warned = checks.filter((c) => c.status === "warn").length;
  const summary =
    failed + warned === 0
      ? "All checks passed."
      : `${failed} failed, ${warned} ${warned === 1 ? "warning" : "warnings"}.`;
  return `${rows.join("\n")}\n\n${summary}\n`;
}

/** Asks the running server, on its own port, what the host helper reports. */
async function fetchHostStatus(port: number): Promise<HostSource> {
  let body: unknown;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/cmd/host.status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(HOST_STATUS_TIMEOUT_MS),
    });
    if (!res.ok) return { problem: `majhi answered ${res.status} to host.status` };
    body = await res.json();
  } catch {
    return { problem: "majhi is not running, so the host helper was not checked" };
  }
  const status = HostStatusSchema.safeParse(body);
  if (!status.success) return { problem: "majhi sent an invalid host.status answer" };
  return { status: status.data };
}
