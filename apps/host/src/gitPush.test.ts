import { describe, expect, it } from "vitest";
import { type GitPushDeps, gitCredential, gitPush, pushArgs, stripCredentials } from "./gitPush.ts";

describe("pushArgs", () => {
  it("refuses force, delete, refspec and option-like branches", () => {
    const url = "https://github.com/acme/api.git";
    for (const branch of ["+main", ":main", "a:b", "--force", "-f", "a..b", "x.lock", "a b", "main^"]) {
      expect(() => pushArgs({ url, branch }), branch).toThrow();
    }
  });

  it("refuses non-https URLs and URLs that carry a password", () => {
    for (const url of [
      "git@github.com:acme/api.git",
      "http://github.com/acme/api.git",
      "ssh://git@github.com/acme/api.git",
      "/Users/owner/api",
      "file:///Users/owner/api",
      "https://u:pw@github.com/acme/api.git",
    ]) {
      expect(() => pushArgs({ url, branch: "main" }), url).toThrow();
    }
  });
});

describe("stripCredentials", () => {
  it("drops user and password from URLs in git output", () => {
    expect(stripCredentials("fatal: unable to access 'https://acme:s3cret@github.com/acme/api.git/'")).toBe(
      "fatal: unable to access 'https://github.com/acme/api.git/'",
    );
  });
});

function deps(run: GitPushDeps["run"]): GitPushDeps {
  return { run, home: "/Users/owner", path: "/usr/bin", kind: async () => "directory" };
}

describe("gitPush", () => {
  it("never prompts and tells an auth failure plainly, without credentials", async () => {
    let env: Record<string, string> = {};
    const run: GitPushDeps["run"] = async (_f, _a, o) => {
      env = o.env;
      return {
        code: 128,
        stdout: "",
        stderr: "fatal: Authentication failed for 'https://acme-dev:s3cretvalue@github.com/acme/api.git/'",
      };
    };
    const err = await gitPush(deps(run), {
      path: "/Users/owner/api",
      url: "https://acme-dev@github.com/acme/api.git",
      branch: "main",
    }).catch((e: Error) => e);
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect((err as Error).message).toContain("no saved login for acme-dev on github.com");
    expect((err as Error).message).not.toContain("s3cretvalue");
  });

  it("refuses a relative path", async () => {
    await expect(
      gitPush(
        deps(async () => ({ code: 0, stdout: "", stderr: "" })),
        {
          path: "api",
          url: "https://github.com/acme/api.git",
          branch: "main",
        },
      ),
    ).rejects.toThrow("absolute");
  });
});

describe("gitCredential", () => {
  it("sends host and account on stdin and returns only the password", async () => {
    let input = "";
    const secret = await gitCredential(
      deps(async (_f, _a, o) => {
        input = o.input ?? "";
        return {
          code: 0,
          stdout: "protocol=https\nhost=github.com\nusername=acme-dev\npassword=tok123\n",
          stderr: "",
        };
      }),
      { host: "github.com", username: "acme-dev" },
    );
    expect(secret).toBe("tok123");
    expect(input).toBe("protocol=https\nhost=github.com\nusername=acme-dev\n\n");
  });

  it("fails with a fixed sentence and refuses injected input", async () => {
    const none = deps(async () => ({ code: 128, stdout: "", stderr: "tok123" }));
    await expect(gitCredential(none, { host: "github.com", username: "acme-dev" })).rejects.toThrow(
      "no saved login for acme-dev on github.com",
    );
    await expect(
      gitCredential(none, { host: "github.com", username: "a\nhost=evil.test" }),
    ).rejects.toThrow();
    await expect(gitCredential(none, { host: "evil.test\nx=1", username: "a" })).rejects.toThrow();
  });
});
