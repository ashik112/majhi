/**
 * Which operating system the helper runs on. It is read once at start; everything that differs
 * between macOS, Linux and Linux inside Windows (WSL2) then goes through `Platform` (types.ts).
 */
import { join } from "node:path";
import type { HostOs } from "@majhi/shared";

export interface OsFacts {
  platform: NodeJS.Platform;
  /** `os.release()`. WSL2 kernels look like `5.15.153.1-microsoft-standard-WSL2`. */
  release: string;
  env: Readonly<Record<string, string | undefined>>;
}

/** True when the kernel release or the environment says this Linux is WSL. */
export function isWsl(release: string, env: Readonly<Record<string, string | undefined>>): boolean {
  return /microsoft|wsl/i.test(release) || env.WSL_DISTRO_NAME !== undefined;
}

/** The helper's OS, or undefined where it does not run (Windows itself, the BSDs). */
export function detectOs(facts: OsFacts): HostOs | undefined {
  if (facts.platform === "darwin") return "macos";
  if (facts.platform === "linux") return isWsl(facts.release, facts.env) ? "wsl" : "linux";
  return undefined;
}

/**
 * Folders where docker, git, node and the editor CLIs live that a login service's PATH may lack,
 * added after the PATH the service was installed with.
 */
export function toolDirs(os: HostOs, home: string): string[] {
  if (os === "macos") return ["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"];
  return ["/usr/local/bin", "/usr/bin", "/bin", "/snap/bin", join(home, ".local", "bin")];
}
