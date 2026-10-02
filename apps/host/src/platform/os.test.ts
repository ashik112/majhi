import { describe, expect, it } from "vitest";
import { detectOs, toolDirs } from "./os.ts";

describe("detectOs", () => {
  it("tells macOS, Linux and WSL2 apart", () => {
    expect(detectOs({ platform: "darwin", release: "24.6.0", env: {} })).toBe("macos");
    expect(detectOs({ platform: "linux", release: "6.8.0-45-generic", env: {} })).toBe("linux");
    expect(detectOs({ platform: "linux", release: "5.15.153.1-microsoft-standard-WSL2", env: {} })).toBe(
      "wsl",
    );
  });

  it("knows WSL by its environment when the kernel name does not say so", () => {
    const env = { WSL_DISTRO_NAME: "Ubuntu" };
    expect(detectOs({ platform: "linux", release: "6.6.36-custom", env })).toBe("wsl");
  });

  it("has no answer where the helper does not run", () => {
    expect(detectOs({ platform: "win32", release: "10.0.26100", env: {} })).toBeUndefined();
    expect(detectOs({ platform: "freebsd", release: "14.1-RELEASE", env: {} })).toBeUndefined();
  });
});

describe("toolDirs", () => {
  it("adds Homebrew on macOS and the user's own bin elsewhere", () => {
    expect(toolDirs("macos", "/Users/owner")).toContain("/opt/homebrew/bin");
    const linux = toolDirs("linux", "/home/owner");
    expect(linux).toContain("/home/owner/.local/bin");
    expect(linux).toContain("/snap/bin");
    expect(linux).not.toContain("/opt/homebrew/bin");
  });
});
