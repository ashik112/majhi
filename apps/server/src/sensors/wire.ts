import { lstat, readFile, realpath } from "node:fs/promises";
import { join, sep } from "node:path";
import type { OrgConfig } from "@majhi/shared";
import { git } from "../git/git.ts";
import { TokenRefused } from "../gitConnect/http.ts";
import type { GitTokens } from "../gitConnect/tokens.ts";
import { type Housekeeper, NoHousekeeper, type Parsed } from "../memory/housekeeper.ts";
import { mrHostOf, mrRemoteName, repoSlug } from "../mrs/remote.ts";
import type { CardRepo } from "../projectcard/repo.ts";
import type { ProjectService } from "../projects/service.ts";
import { parseRemoteUrl } from "../scan/remote.ts";
import type { Store } from "../store/index.ts";
import { SensorCache } from "./cache.ts";
import { Net } from "./net.ts";
import type { SensorPorts, SensorProject } from "./ports.ts";

/** The real pieces behind the sensors' ports: projects, read-only checkouts, git sign-in, the smallest model. */
export interface SensorWiring {
  store: Store;
  projects: ProjectService;
  cards: CardRepo;
  tokens: GitTokens;
  orgs: () => Promise<Record<string, OrgConfig>>;
  housekeeper?: Housekeeper | undefined;
  /** Laya's injection check for third-party text; absent: the plain-pattern check only. */
  injects?: ((text: string) => Promise<boolean>) | undefined;
  /** For tests: the network the sensors use, and the hosts they may reach. */
  net?: Net;
  now?: () => Date;
  log?: (message: string) => void;
}

async function tryGit(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    return await git(cwd, args);
  } catch {
    return undefined;
  }
}

export function createSensorPorts(w: SensorWiring): SensorPorts {
  const cache = new SensorCache(w.store.raw);
  const net = w.net ?? new Net();
  return {
    net,
    cache,
    now: w.now ?? (() => new Date()),
    log: w.log ?? ((m) => console.error(m)),
    ...(w.injects === undefined ? {} : { injects: w.injects }),
    async projects(org) {
      const out: SensorProject[] = [];
      for (const p of await w.projects.infos()) {
        if (p.org !== org || !p.exists) continue;
        const remoteName = mrRemoteName(p.remotes);
        const url = (await tryGit(p.path, ["config", "--get", `remote.${remoteName}.url`]))?.trim();
        let remote: SensorProject["remote"];
        if (url !== undefined && url !== "") {
          const kind = mrHostOf(p.remotes[remoteName], url);
          const host = parseRemoteUrl(url).host;
          if ((kind === "github" || kind === "gitlab") && host !== undefined) {
            remote = { kind, host: kind === "github" ? "github.com" : host, slug: repoSlug(url) };
          }
        }
        out.push({
          id: p.id,
          org: p.org,
          path: p.path,
          base: p.base,
          remote,
          stack: w.cards.get(p.id)?.card.stack ?? [],
        });
      }
      return out;
    },
    async tracked(path) {
      const out = await tryGit(path, ["ls-files", "-z"]);
      return out === undefined ? [] : out.split("\0").filter((f) => f !== "");
    },
    async read(path, rel, maxBytes) {
      if (rel.startsWith("/") || rel.split("/").includes("..")) return undefined;
      try {
        const full = join(path, rel);
        const info = await lstat(full);
        if (!info.isFile() || info.size > maxBytes) return undefined;
        const [root, real] = await Promise.all([realpath(path), realpath(full)]);
        if (real !== root && !real.startsWith(root + sep)) return undefined;
        const buf = await readFile(full);
        // A NUL byte in the first block: binary, not text.
        if (buf.subarray(0, 8000).includes(0)) return undefined;
        return buf.toString("utf8");
      } catch {
        return undefined;
      }
    },
    async fingerprint(path) {
      const tree = await tryGit(path, ["rev-parse", "HEAD^{tree}"]);
      if (tree === undefined) return undefined;
      const status = (await tryGit(path, ["status", "--porcelain", "-z"])) ?? "";
      return `${tree.trim()}\n${status}`;
    },
    async taskBranches(org, project) {
      const branches = new Set<string>();
      for (const t of w.store.tasks.list(false)) {
        if ((t.org ?? "private") !== org || t.chat === true || t.status === "done") continue;
        for (const r of t.repos) if (r.project === project) branches.add(r.branch);
      }
      return [...branches];
    },
    async withToken(org, kind, host, use) {
      try {
        const res = await w.tokens.withToken(org, kind, host, (token) => use(token));
        if (res.state === "ok") return { state: "ok", value: res.value };
        return { state: res.state === "signed-out" ? "signed-out" : "refused" };
      } catch (err) {
        if (err instanceof TokenRefused) return { state: "refused" };
        throw err;
      }
    },
    ...(w.housekeeper === undefined
      ? {}
      : {
          async summarize(org: string, project: string, prompt: string) {
            const housekeeper = w.housekeeper;
            if (housekeeper === undefined) return undefined;
            try {
              // The Housekeeper checks the answer with this and asks again when it fails; the sensor
              // does its own strict parse afterwards, so here any reply passes.
              const raw = (text: string): Parsed<string> => ({ ok: true, value: text });
              const { value } = await housekeeper.ask({ id: `radar:${project}`, org }, prompt, raw);
              return value;
            } catch (err) {
              if (err instanceof NoHousekeeper) return undefined;
              throw err;
            }
          },
        }),
  };
}
