import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { basename, join, sep } from "node:path";

/** What the scanner reads of a repo: text files and folder listings, by path relative to its root. */
export interface RepoFiles {
  /** A text file, or undefined when it is missing, a secret file, too big or outside the repo. */
  read(rel: string): Promise<string | undefined>;
  /** The entries of a folder; empty when it is missing or outside the repo. */
  list(rel: string): Promise<{ name: string; dir: boolean }[]>;
}

const MAX_BYTES = 200_000;

/** Files that hold credentials. They are never opened, whatever asks for them. */
const SECRET_NAME =
  /^(\.env($|[._-])|\.envrc$|\.npmrc$|\.pypirc$|\.netrc$|\.git-credentials$|id_(rsa|dsa|ecdsa|ed25519)|credentials($|[._-])|secrets?($|[._-])|.*\.(pem|key|p12|pfx|jks|keystore|kdbx|tfstate|tfvars)$)/i;

/** Env templates carry names, not values, but stay unread too: the card needs only that they exist. */
export function isSecretFile(rel: string): boolean {
  return rel.split("/").some((part) => SECRET_NAME.test(part));
}

/**
 * A repo's files for the scanner. Symlinks are never followed and nothing outside the root is read,
 * so a repo cannot point the scan at the owner's other files.
 */
export function fsRepoFiles(root: string): RepoFiles {
  let real: string | undefined;
  const inside = async (rel: string): Promise<string | undefined> => {
    if (rel.split("/").includes("..") || rel.startsWith("/")) return undefined;
    try {
      real ??= await realpath(root);
      const path = join(root, rel);
      const info = await lstat(path);
      if (info.isSymbolicLink()) return undefined;
      const target = await realpath(path);
      return target === real || target.startsWith(real + sep) ? path : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    async read(rel) {
      if (isSecretFile(rel)) return undefined;
      const path = await inside(rel);
      if (path === undefined) return undefined;
      try {
        const info = await lstat(path);
        if (!info.isFile() || info.size > MAX_BYTES) return undefined;
        return await readFile(path, "utf8");
      } catch {
        return undefined;
      }
    },
    async list(rel) {
      const path = rel === "" ? root : await inside(rel);
      if (path === undefined) return [];
      try {
        const entries = await readdir(path, { withFileTypes: true });
        return (
          entries
            // Names are listed (an env template tells setup is needed); contents of secret files never are.
            .filter((e) => !e.isSymbolicLink())
            .map((e) => ({ name: e.name, dir: e.isDirectory() }))
            .sort((a, b) => a.name.localeCompare(b.name))
        );
      } catch {
        return [];
      }
    },
  };
}

/** The folder name of a checkout, for naming it. */
export function folderName(path: string): string {
  return basename(path.replace(/[/\\]+$/, ""));
}
