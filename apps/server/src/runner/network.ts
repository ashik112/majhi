import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** True when `ip` (IPv4, or IPv4 mapped into IPv6) is inside the IPv4 `cidr`. */
export function inSubnet(ip: string, cidr: string): boolean {
  const [base, bitsText] = cidr.split("/");
  const bits = Number(bitsText);
  const a = ipv4(ip.startsWith("::ffff:") ? ip.slice(7) : ip);
  const b = base === undefined ? undefined : ipv4(base);
  if (a === undefined || b === undefined || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (a & mask) >>> 0 === (b & mask) >>> 0;
}

function ipv4(text: string): number | undefined {
  const parts = text.split(".");
  if (parts.length !== 4) return undefined;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return undefined;
    const v = Number(p);
    if (v > 255) return undefined;
    n = n * 256 + v;
  }
  return n;
}

export interface Subnet {
  cidr: string;
  /** The gateway: traffic Docker forwards from the host (the owner's browser) comes from here. */
  gateway: string;
}

export type Inspect = (network: string) => Promise<Subnet[]>;

/** The first address of an IPv4 subnet, Docker's default gateway. */
function firstHost(cidr: string): string {
  const [base = ""] = cidr.split("/");
  const parts = base.split(".").map(Number);
  parts[3] = (parts[3] ?? 0) + 1;
  return parts.join(".");
}

/** Asks Docker for the network's IPv4 subnets and gateways. */
export function dockerInspect(docker: string, cliEnv: Record<string, string>): Inspect {
  return async (network) => {
    const { stdout } = await run(
      docker,
      ["network", "inspect", network, "--format", "{{range .IPAM.Config}}{{.Subnet}}|{{.Gateway}} {{end}}"],
      { env: cliEnv, timeout: 10_000 },
    );
    return parseSubnets(stdout);
  };
}

export function parseSubnets(text: string): Subnet[] {
  const out: Subnet[] = [];
  for (const entry of text.split(/\s+/).filter(Boolean)) {
    const [cidr = "", gateway = ""] = entry.split("|");
    if (!/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(cidr)) continue;
    out.push({ cidr, gateway: /^\d+\.\d+\.\d+\.\d+$/.test(gateway) ? gateway : firstHost(cidr) });
  }
  return out;
}

/**
 * The runner network (Phase 2c). Requests from it may reach only `/mcp`, the tools agents are
 * given; majhi's API and pages answer only the owner. No runner starts until the network's
 * subnets are known, so there is never a runner majhi cannot tell apart.
 */
export class RunnerNetwork {
  private subnets: Subnet[] = [];
  private lookup: Promise<void> | undefined;

  constructor(
    readonly name: string,
    private readonly inspect: Inspect,
  ) {}

  /** Reads the subnets once. Rejects with a plain message when Docker cannot say. */
  ensure(): Promise<void> {
    if (this.subnets.length > 0) return Promise.resolve();
    this.lookup ??= (async () => {
      try {
        const found = await this.inspect(this.name);
        if (found.length === 0) throw new Error("it has no IPv4 subnet");
        this.subnets = found;
      } catch (err) {
        const why = err instanceof Error ? err.message.split("\n", 1)[0] : String(err);
        throw new Error(
          `majhi cannot read the runner network ${this.name} (${why}), so agents cannot start. Update majhi to recreate it.`,
        );
      } finally {
        this.lookup = undefined;
      }
    })();
    return this.lookup;
  }

  /** True for a request that came from a runner. The gateway is the host, not a runner. */
  isRunner(remoteAddress: string | undefined): boolean {
    if (remoteAddress === undefined) return false;
    const ip = remoteAddress.startsWith("::ffff:") ? remoteAddress.slice(7) : remoteAddress;
    return this.subnets.some((s) => ip !== s.gateway && inSubnet(ip, s.cidr));
  }
}
