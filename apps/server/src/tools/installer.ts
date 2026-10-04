import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import {
  type InstalledTool,
  InstalledToolSchema,
  type ToolInstallInput,
  type ToolsList,
} from "@majhi/shared";
import { z } from "zod";
import { unpackTo } from "../backup/tar.ts";
import { UserError } from "../errors.ts";
import { publicHostProblem } from "../ops/anything/checks.ts";
import { extractZip } from "../skills/zip.ts";

/**
 * Installs command-line tools into a workspace's tools folder, `<majhi home>/tools/<org>/bin`, the
 * folder runs, watch scripts and secret fetches already put first on PATH. majhi does the download:
 * https only, public hosts only, a size cap, and the file is kept only when its SHA-256 matches the
 * one given or the one in the vendor's checksums file. Nothing downloaded is run here.
 */

/** The biggest download. Release binaries of cluster and cloud tools are tens of megabytes. */
export const MAX_DOWNLOAD_BYTES = 300 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const DOWNLOAD_MS = 5 * 60_000;
const CHECKSUMS_MAX_BYTES = 1024 * 1024;
const ORG = /^[a-z0-9][a-z0-9-]{0,62}$/;
/**
 * Where the checked copies live, `<home>/tool-installs/<org>`: `bin` and the record of what was
 * installed. Runs never mount it, so an agent cannot change what is in it. Watch scripts and secret
 * fetches, which hold a workspace's connection values, mount only this `bin`, read-only. The same
 * programs are copied into the workspace's tools folder, which runs mount and put on PATH.
 */
export const VERIFIED_DIR = "tool-installs";

/** The folder of checked programs a script run mounts, read-only. */
export function verifiedBin(majhiHome: string, org: string): string {
  if (!ORG.test(org)) throw new UserError(`Not a workspace id: ${org}`, 400);
  return join(majhiHome, VERIFIED_DIR, org, "bin");
}

const ManifestSchema = z.record(z.string(), InstalledToolSchema);

export interface InstallerDeps {
  majhiHome: string;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  lookup(host: string): Promise<string[]>;
  now?: () => Date;
  /** The runner image's CPU. Defaults to this process's. */
  cpu?: string;
}

/** The CPU a download must match. The runner image is built for the CPU majhi runs on. */
export function archOf(cpu: string): ToolsList["arch"] {
  return cpu === "arm64" || cpu === "aarch64"
    ? { arch: "arm64", machine: "aarch64" }
    : { arch: "amd64", machine: "x86_64" };
}

/** `{arch}` and `{machine}` in a vendor URL, for the CPU. */
export function expandUrl(url: string, arch: ToolsList["arch"]): string {
  return url.replaceAll("{arch}", arch.arch).replaceAll("{machine}", arch.machine);
}

/** The hash a checksums file gives for `file`: one bare hash, or the `<hash>  <name>` line of that file. */
export function checksumFor(text: string, file: string): string | undefined {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  const bare = lines.length === 1 ? /^([0-9a-fA-F]{64})$/.exec(lines[0] ?? "") : null;
  if (bare?.[1] !== undefined) return bare[1].toLowerCase();
  for (const line of lines) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(\S+)$/.exec(line);
    if (m?.[1] !== undefined && m[2] !== undefined && basename(m[2]) === file) return m[1].toLowerCase();
  }
  return undefined;
}

export class ToolInstaller {
  constructor(private readonly deps: InstallerDeps) {}

  private get arch(): ToolsList["arch"] {
    return archOf(this.deps.cpu ?? process.arch);
  }

  private at(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  /** `<home>/tools/<org>`. The workspace id is checked, so the folder cannot leave `tools`. */
  root(org: string): string {
    if (!ORG.test(org)) throw new UserError(`Not a workspace id: ${org}`, 400);
    return join(this.deps.majhiHome, "tools", org);
  }

  private recordFile(org: string): string {
    this.root(org);
    return join(this.deps.majhiHome, VERIFIED_DIR, org, "installed.json");
  }

  async list(org: string): Promise<ToolsList> {
    this.root(org);
    return { org, arch: this.arch, tools: Object.values(await this.manifest(org)) };
  }

  private async manifest(org: string): Promise<Record<string, InstalledTool>> {
    try {
      const raw: unknown = JSON.parse(await readFile(this.recordFile(org), "utf8"));
      const parsed = ManifestSchema.safeParse(raw);
      return parsed.success ? parsed.data : {};
    } catch {
      return {};
    }
  }

  private async saveManifest(org: string, tools: Record<string, InstalledTool>): Promise<void> {
    const file = this.recordFile(org);
    await mkdir(join(this.deps.majhiHome, VERIFIED_DIR, org), { recursive: true });
    const tmp = `${file}.${randomBytes(4).toString("hex")}`;
    await writeFile(tmp, `${JSON.stringify(tools, null, 2)}\n`);
    await rename(tmp, file);
  }

  async remove(org: string, name: string): Promise<{ name: string }> {
    const tools = await this.manifest(org);
    if (tools[name] === undefined) throw new UserError(`${name} is not installed in this workspace.`, 404);
    await rm(join(this.root(org), "bin", name), { force: true });
    await rm(join(verifiedBin(this.deps.majhiHome, org), name), { force: true });
    delete tools[name];
    await this.saveManifest(org, tools);
    return { name };
  }

  async install(org: string, input: ToolInstallInput): Promise<InstalledTool> {
    const root = this.root(org);
    const url = expandUrl(input.url, this.arch);
    const file = basename(new URL(url).pathname);
    // The checksum first: a bad checksum source costs no download.
    let expected = input.sha256;
    let verifiedBy: InstalledTool["verifiedBy"] = "given";
    if (expected === undefined && input.checksumUrl !== undefined) {
      const sums = await this.download(expandUrl(input.checksumUrl, this.arch), CHECKSUMS_MAX_BYTES);
      expected = checksumFor(sums.toString("utf8"), file);
      verifiedBy = "checksum-file";
      if (expected === undefined) {
        throw new UserError(`The checksums file has no SHA-256 for ${file}. Nothing was installed.`, 400);
      }
    }
    if (expected === undefined) throw new UserError("Give sha256 or checksumUrl.", 400);

    const data = await this.download(url, MAX_DOWNLOAD_BYTES);
    const actual = createHash("sha256").update(data).digest("hex");
    if (actual !== expected) {
      throw new UserError(
        `The download's SHA-256 is ${actual}, not the expected ${expected}. Nothing was installed.`,
        400,
      );
    }

    const staging = join(
      this.deps.majhiHome,
      VERIFIED_DIR,
      org,
      `.staging-${randomBytes(6).toString("hex")}`,
    );
    await mkdir(staging, { recursive: true });
    try {
      const program = await this.program(staging, data, input);
      // Written beside the target and renamed over it, so a run never sees half a program.
      for (const bin of [verifiedBin(this.deps.majhiHome, org), join(root, "bin")]) {
        await mkdir(bin, { recursive: true });
        const target = join(bin, input.name);
        const tmp = `${target}.${randomBytes(4).toString("hex")}.part`;
        await writeFile(tmp, program);
        await chmod(tmp, 0o755);
        await rename(tmp, target);
      }
      const entry: InstalledTool = {
        name: input.name,
        url,
        sha256: actual,
        verifiedBy,
        bytes: program.length,
        installedAt: this.at(),
      };
      await this.saveManifest(org, { ...(await this.manifest(org)), [input.name]: entry });
      return entry;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  /** The program's bytes: the download itself, or the file at `path` inside the unpacked archive. */
  private async program(staging: string, data: Buffer, input: ToolInstallInput): Promise<Buffer> {
    if (input.archive === "binary") return data;
    const unpacked = join(staging, "unpacked");
    await mkdir(unpacked, { recursive: true });
    if (input.archive === "tar.gz") {
      await unpackTo(Readable.from(data), unpacked).catch((err: unknown) => {
        throw new UserError(
          `The archive could not be unpacked: ${err instanceof Error ? err.message : ""}`,
          400,
        );
      });
    } else {
      await extractZip(data, unpacked);
    }
    const wanted = resolve(unpacked, input.path ?? input.name);
    const base = await realpath(unpacked);
    const info = await lstat(wanted).catch(() => undefined);
    if (info === undefined) throw new UserError(`The archive has no ${input.path ?? input.name}.`, 400);
    // A link in the archive could point anywhere on this machine: only a plain file inside it counts.
    const real = await realpath(wanted);
    if (info.isSymbolicLink() || !info.isFile() || !real.startsWith(base + sep)) {
      throw new UserError(`${input.path ?? input.name} in the archive is not a plain file.`, 400);
    }
    return readFile(real);
  }

  /** A public https download, redirects followed by hand so each hop is checked, capped in size and time. */
  private async download(start: string, limit: number): Promise<Buffer> {
    let target = start;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const url = new URL(target);
      if (url.protocol !== "https:") throw new UserError("Tools are downloaded over https only.", 400);
      const problem = await publicHostProblem(url.hostname, { lookup: this.deps.lookup });
      if (problem !== undefined) throw new UserError(problem, 400);
      const res = await this.deps
        .fetch(target, {
          method: "GET",
          redirect: "manual",
          credentials: "omit",
          signal: AbortSignal.timeout(DOWNLOAD_MS),
        })
        .catch((err: unknown) => {
          throw new UserError(
            `The download failed: ${err instanceof Error ? err.message : "no answer"}`,
            409,
          );
        });
      const next = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && next !== null) {
        void res.body?.cancel().catch(() => undefined);
        target = new URL(next, target).href;
        continue;
      }
      if (!res.ok) {
        void res.body?.cancel().catch(() => undefined);
        throw new UserError(`The download answered ${res.status}.`, 409);
      }
      return readCapped(res, limit);
    }
    throw new UserError("The download redirected too many times.", 409);
  }
}

async function readCapped(res: Response, limit: number): Promise<Buffer> {
  if (res.body === null) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        throw new UserError(`The download is bigger than ${Math.round(limit / 1024 / 1024)} MB.`, 400);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks);
}
