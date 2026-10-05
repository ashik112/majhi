import { describe, expect, it } from "vitest";
import { ContainerRefused } from "./args.ts";
import { DockerCli } from "./docker.ts";

/** The one `docker exec` majhi makes: it re-sets the network guard of a container it started. */
describe("DockerCli.guard", () => {
  const cli = new DockerCli({
    docker: "/nonexistent/docker",
    cliEnv: {},
    majhiHome: "/Users/owner/.majhi",
    hostHome: "/Users/owner",
    protectedPaths: [],
  });
  const server = { host: "majhi-server", port: 7070 };

  it("refuses anything but a majhi container and IPv4 subnets", () => {
    expect(() => cli.guard("postgres", ["192.168.171.0/24"], server)).toThrow(ContainerRefused);
    expect(() => cli.guard("majhi-run-aaa; rm", ["192.168.171.0/24"], server)).toThrow(ContainerRefused);
    expect(() => cli.guard("majhi-run-aaa", ["--privileged"], server)).toThrow(ContainerRefused);
    expect(() => cli.guard("majhi-run-aaa", ["10.0.0.0/4"], server)).toThrow(ContainerRefused);
    expect(() => cli.guard("majhi-run-aaa", ["fd00::/8"], server)).toThrow(ContainerRefused);
  });

  it("refuses a server that is not a majhi name", () => {
    expect(() => cli.guard("majhi-run-aaa", [], { host: "evil.example.com", port: 7070 })).toThrow(
      ContainerRefused,
    );
    expect(() => cli.guard("majhi-run-aaa", [], { host: "majhi-server", port: 1.5 })).toThrow(
      ContainerRefused,
    );
  });
});
