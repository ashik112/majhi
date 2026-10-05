import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { renderOverride } from "./genOverride.ts";

const base = { file: "/Users/me/.majhi/majhi.yaml", home: "/Users/me" };
/** No SSH agent, so only what a test is about shows. */
const OFF = { sshAgent: "off" };

describe("renderOverride", () => {
  it("mounts every root at the same path, and survives spaces and colons", () => {
    const roots = [
      "/Users/me/Work",
      "/Users/me/My Projects/client work",
      "/Volumes/Ext: Disk/code",
      "/Users/me/#x",
    ];
    const text = renderOverride(
      {
        status: "loaded",
        ...base,
        config: { workspaces: roots, tasksDir: "/Users/me/Work/.majhi" },
      },
      [],
      undefined,
      OFF,
    );

    expect(parse(text)).toEqual({
      services: {
        server: {
          volumes: [
            "/Users/me/Work:/Users/me/Work",
            "/Users/me/My Projects/client work:/Users/me/My Projects/client work",
            { type: "bind", source: "/Volumes/Ext: Disk/code", target: "/Volumes/Ext: Disk/code" },
            "/Users/me/#x:/Users/me/#x",
          ],
        },
      },
    });
  });

  it("never mounts a source without the .pub suffix: a private key cannot reach the override", () => {
    const config = { workspaces: ["/Users/me/Work"], tasksDir: "/Users/me/Work/.majhi" };
    for (const bad of [
      "/Users/me/.ssh/id_ed25519",
      "/Users/me/.ssh",
      "id_rsa.pub",
      "/Users/me/.ssh/id_rsa.pub.bak",
    ]) {
      expect(() => renderOverride({ status: "loaded", ...base, config }, [bad])).toThrow();
    }
    const text = renderOverride({ status: "loaded", ...base, config }, ["/Users/me/.ssh/id_rsa.pub"]);
    const volumes = parse(text).services.server.volumes as Array<
      string | { source: string; read_only?: boolean }
    >;
    const sources = volumes.flatMap((v) => (typeof v === "object" && v.read_only ? [v.source] : []));
    expect(sources.every((s) => s.endsWith(".pub"))).toBe(true);
  });

});

describe("renderOverride: the SSH agent", () => {
  const linux = { file: "/home/owner/.majhi/majhi.yaml", home: "/home/owner" };
  const majhiHome = "/home/owner/.majhi";
  const server = (sshAgent: string | undefined) =>
    parse(renderOverride({ status: "first-run", ...linux }, [], undefined, { sshAgent, majhiHome })).services
      .server;

  it("mounts a socket that only looks like it is under MAJHI_HOME", () => {
    expect(server("/home/owner/.majhi-old/ssh-agent.sock")).toEqual({
      volumes: ["/home/owner/.majhi-old/ssh-agent.sock:/run/ssh-agent.sock"],
      environment: { SSH_AUTH_SOCK: "/run/ssh-agent.sock" },
    });
    expect(server("/home/owner/.majhi/../.ssh/agent.sock")).toEqual({
      volumes: ["/home/owner/.ssh/agent.sock:/run/ssh-agent.sock"],
      environment: { SSH_AUTH_SOCK: "/run/ssh-agent.sock" },
    });
  });

  it("refuses a relative path or one with a line break", () => {
    for (const bad of ["run/ssh-agent.sock", "~/.majhi/run/ssh-agent.sock", "/tmp/a\nb.sock", "OFF"]) {
      expect(() => server(bad)).toThrow();
    }
  });
});

