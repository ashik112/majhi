import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AgentFrontmatterSchema, type CommandMeta, GLOBAL_CONNECTIONS } from "@majhi/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { AgentStore } from "../agents/store.ts";
import { readSections } from "../config/sections.ts";
import { ConfigService } from "../config/service.ts";
import { ConfigConflictError } from "../config/write.ts";
import { OrgService } from "../orgs/service.ts";
import { SecretService } from "../secrets/service.ts";
import { generateKey, SecretStore } from "../secrets/store.ts";
import { tempDir, writeKeyFile } from "../testing/fixtures.ts";
import { UploadStore } from "../uploads/store.ts";
import { ConnectionService, connectionDir } from "./service.ts";

const OWNER: CommandMeta = { actor: { kind: "owner" } };
const KUBECONFIG = "apiVersion: v1\nkind: Config\ncontexts: []\n";
const API_KEY = "sk-or-v1-0123456789abcdef0123456789abcdef";

describe("ConnectionService storage", () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  let majhiHome: string;
  let config: ConfigService;
  let secrets: SecretStore;
  let uploads: UploadStore;
  let agents: AgentStore;
  let service: ConnectionService;
  const yaml = () => readFile(config.file, "utf8");
  const upload = (org?: string) =>
    uploads
      .save({
        name: "config",
        mime: "",
        data: new TextEncoder().encode(KUBECONFIG),
        purpose: "connection",
        ...(org === undefined ? {} : { org }),
      })
      .then((a) => a.id);

  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir());
    majhiHome = join(dir, ".majhi");
    await mkdir(majhiHome, { recursive: true });
    const keyFile = join(dir, "config", "secrets.key");
    await writeKeyFile(keyFile, await generateKey());
    config = new ConfigService({ majhiHome, hostHome: dir });
    await writeFile(
      config.file,
      "workspaces: [~/Work]\norgs:\n  acme: { name: Acme }\n  globex: { name: Globex }\n",
    );
    secrets = new SecretStore(majhiHome, keyFile);
    uploads = new UploadStore(majhiHome);
    agents = new AgentStore(majhiHome);
    const secretService = new SecretService(secrets, config);
    service = new ConnectionService({ config, secrets, secretService, uploads, agents, majhiHome });
  });
  afterEach(() => cleanup());

  it("keeps shared connections outside orgs, encrypts their secrets, and includes them in workspace lists", async () => {
    await service.create(
      {
        org: GLOBAL_CONNECTIONS,
        id: "shared-api",
        type: "env",
        name: "Shared API",
        vars: { API_TOKEN: { kind: "secret" } },
      },
      "connections.create",
      OWNER,
    );
    await service.setSecret(
      { id: "shared-api", field: "API_TOKEN", list: "vars", value: API_KEY },
      "connections.setSecret",
      OWNER,
    );
    const text = await yaml();
    expect(parse(text).connections["shared-api"].vars.API_TOKEN.value).toMatch(/^secret:/);
    expect(text).not.toContain(API_KEY);
    expect(parse(text).orgs.global).toBeUndefined();
    expect((await readSections(config.file)).orgs.global).toBeUndefined();
    expect((await service.list("acme")).map((c) => c.org)).toEqual([GLOBAL_CONNECTIONS]);
    expect((await service.get("shared-api")).vars.API_TOKEN).toEqual({ kind: "secret", set: true });
    await service.remove("shared-api", "connections.remove", OWNER);
    expect(parse(await yaml()).connections).toBeUndefined();
    expect(await secrets.names()).toEqual([]);
  });

  it("refuses agents changing or creating a Global connection", async () => {
    const agent: CommandMeta = { actor: { kind: "agent", id: "root-agent" } };
    const input = {
      org: GLOBAL_CONNECTIONS,
      id: "shared-api",
      type: "env" as const,
      name: "Shared API",
      vars: { API_TOKEN: { kind: "secret" as const } },
    };
    await expect(service.create(input, "connections.create", agent)).rejects.toThrow(/Only the owner/);
    await service.create(input, "connections.create", OWNER);
    const before = await yaml();
    await expect(
      service.update({ id: "shared-api", name: "Changed" }, "connections.update", agent),
    ).rejects.toThrow(/Only the owner/);
    await expect(
      service.setSecret(
        { id: "shared-api", field: "API_TOKEN", list: "vars", value: API_KEY },
        "connections.setSecret",
        agent,
      ),
    ).rejects.toThrow(/Only the owner/);
    await expect(service.setAllow("shared-api", ["*"], "connections.allow", agent)).rejects.toThrow(
      /Only the owner/,
    );
    await expect(service.remove("shared-api", "connections.remove", agent)).rejects.toThrow(/Only the owner/);
    expect(await yaml()).toBe(before);
  });

  it("rejects duplicate ids across Global and workspace connections, including hand edits", async () => {
    await service.create(
      { org: GLOBAL_CONNECTIONS, id: "shared-api", type: "env", name: "Shared API" },
      "connections.create",
      OWNER,
    );
    await expect(
      service.create(
        { org: "acme", id: "shared-api", type: "env", name: "Acme API" },
        "connections.create",
        OWNER,
      ),
    ).rejects.toThrow(/already a connection/);
    await writeFile(
      config.file,
      "workspaces: [~/Work]\nconnections:\n  shared-api: { type: env, name: Shared API }\norgs:\n  acme:\n    name: Acme\n    connections:\n      shared-api: { type: env, name: Acme API }\n",
    );
    await expect(readSections(config.file)).rejects.toThrow(/invalid orgs/);
  });

  async function kubectl(id = "acme-prod", org = "acme") {
    await service.create(
      { org, id, type: "kubectl", name: "Acme prod", fields: { context: "prod" } },
      "connections.create",
      OWNER,
    );
    return service.setFile({ id, field: "kubeconfig", upload: await upload() }, "connections.setFile", OWNER);
  }

  async function env() {
    await service.create(
      {
        org: "acme",
        id: "acme-openrouter",
        type: "env",
        name: "OpenRouter",
        vars: { API_KEY: { kind: "secret" } },
      },
      "connections.create",
      OWNER,
    );
    return service.setSecret(
      { id: "acme-openrouter", field: "API_KEY", list: "vars", value: API_KEY },
      "connections.setSecret",
      OWNER,
    );
  }

  it("keeps text in majhi.yaml, the secret in secrets.age and the file owner-only", async () => {
    const view = await kubectl();
    expect(view.fields.kubeconfig).toEqual({ kind: "file", set: true });
    expect(view.fields.context).toEqual({ kind: "text", set: true, value: "prod" });
    expect(view.problems).toEqual([]);
    const folder = connectionDir(majhiHome, "acme-prod");
    expect((await stat(join(majhiHome, "connections"))).mode & 0o777).toBe(0o700);
    expect((await stat(folder)).mode & 0o777).toBe(0o700);
    expect((await stat(join(folder, "kubeconfig"))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(folder, "kubeconfig"), "utf8")).toBe(KUBECONFIG);

    const keys = await env();
    expect(keys.vars.API_KEY).toEqual({ kind: "secret", set: true });
    expect(JSON.stringify(keys)).not.toContain(API_KEY);
    const text = await yaml();
    expect(text).not.toContain(API_KEY);
    const stored = parse(text).orgs.acme.connections;
    expect(stored["acme-prod"].fields).toEqual({ context: "prod", kubeconfig: "file:kubeconfig" });
    const ref: string = stored["acme-openrouter"].vars.API_KEY.value;
    expect(ref).toMatch(/^secret:acme-openrouter-api-key/);
    expect(await secrets.get(ref.slice("secret:".length))).toBe(API_KEY);

    // The whole file still loads, and orgs read the connections back.
    expect((await config.load()).state.status).toBe("loaded");
    expect(Object.keys((await readSections(config.file)).orgs.acme?.connections ?? {})).toEqual([
      "acme-prod",
      "acme-openrouter",
    ]);
    expect(await service.list("globex")).toEqual([]);
  });

  it("survives an org edit, the round trip every org setting goes through", async () => {
    await kubectl();
    await new OrgService(config, agents).update({ id: "acme", name: "Acme Inc" }, "orgs.update", OWNER);
    const view = await service.get("acme-prod");
    expect(view.fields.kubeconfig?.set).toBe(true);
    expect(parse(await yaml()).orgs.acme.name).toBe("Acme Inc");
  });

  it("writes the built-in Private org whole, so it keeps its name", async () => {
    await service.create(
      { org: "private", type: "ssh", name: "Home lab", fields: { alias: "lab" } },
      "connections.create",
      OWNER,
    );
    const org = parse(await yaml()).orgs.private;
    expect(org.name).toBe("Private");
    expect(org.connections["home-lab"].fields.alias).toBe("lab");
    expect((await config.load()).state.status).toBe("loaded");
  });

  it("keeps ids unique across orgs, also against a hand edit", async () => {
    await kubectl("prod");
    await expect(
      service.create({ org: "globex", id: "prod", type: "ssh", name: "Prod" }, "connections.create", OWNER),
    ).rejects.toMatchObject({ status: 409 });
    const text = await yaml();
    await writeFile(
      config.file,
      text.replace(
        "globex: { name: Globex }",
        "globex: { name: Globex, connections: { prod: { type: ssh, name: X } } }",
      ),
    );
    await expect(readSections(config.file)).rejects.toBeInstanceOf(ConfigConflictError);
    expect((await config.load()).state.status).not.toBe("loaded");
  });

  it("replacing a secret deletes the old one", async () => {
    await env();
    const first = parse(await yaml()).orgs.acme.connections["acme-openrouter"].vars.API_KEY.value as string;
    await service.setSecret(
      { id: "acme-openrouter", field: "API_KEY", list: "vars", value: `${API_KEY}-2` },
      "connections.setSecret",
      OWNER,
    );
    const second = parse(await yaml()).orgs.acme.connections["acme-openrouter"].vars.API_KEY.value as string;
    expect(second).not.toBe(first);
    expect(await secrets.has(first.slice("secret:".length))).toBe(false);
    expect(await secrets.get(second.slice("secret:".length))).toBe(`${API_KEY}-2`);
  });

  it("remove deletes its secrets, files and agent links, and keeps a secret something else uses", async () => {
    await kubectl();
    await env();
    await secrets.set("shared-token", "tok-0123456789");
    await writeFile(
      config.file,
      `${await yaml()}accounts:\n  api: { tool: claude, org: acme, auth: api-key, key: secret:shared-token }\n`,
    );
    await service.create(
      {
        org: "acme",
        id: "acme-mail",
        type: "mail",
        name: "Mail",
        fields: { imap_host: "imap.acme.com", user: "ops" },
      },
      "connections.create",
      OWNER,
    );
    await service.setSecret(
      { id: "acme-mail", field: "password", ref: "secret:shared-token" },
      "connections.setSecret",
      OWNER,
    );
    await agents.write({
      frontmatter: AgentFrontmatterSchema.parse({
        id: "acme-builder",
        scope: "acme",
        role: "Builder",
        account: "api",
        connections: ["acme-prod", "acme-openrouter"],
      }),
      instructions: "Builds.",
    });
    expect((await service.get("acme-prod")).agents).toEqual(["acme-builder"]);
    const ref = parse(await yaml()).orgs.acme.connections["acme-openrouter"].vars.API_KEY.value as string;

    await service.remove("acme-prod", "connections.remove", OWNER);
    await service.remove("acme-openrouter", "connections.remove", OWNER);
    await service.remove("acme-mail", "connections.remove", OWNER);

    expect(parse(await yaml()).orgs.acme.connections).toBeUndefined();
    await expect(stat(connectionDir(majhiHome, "acme-prod"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await secrets.has(ref.slice("secret:".length))).toBe(false);
    expect(await secrets.get("shared-token")).toBe("tok-0123456789");
    const agent = await agents.get("acme-builder");
    expect(agent?.ok && agent.agent.frontmatter.connections).toEqual([]);
  });

  it("refuses a file from a task of another org, and connection files as attachments", async () => {
    await service.create(
      { org: "acme", id: "acme-prod", type: "kubectl", name: "Acme prod" },
      "connections.create",
      OWNER,
    );
    const foreign = await upload("globex");
    await expect(
      service.setFile(
        { id: "acme-prod", field: "kubeconfig", upload: foreign },
        "connections.setFile",
        OWNER,
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(uploads.take(foreign, join(dir, "task"))).rejects.toThrow(/connection's file/);
  });

  it("refuses values that do not fit before writing anything", async () => {
    const before = await yaml();
    const bad = [
      { org: "acme", type: "kubectl", name: "A", fields: { kubeconfig: "file:x" } },
      { org: "acme", type: "mail", name: "B", fields: { password: "hunter2" } },
      { org: "acme", type: "mail", name: "C", fields: { imap_port: "imap" } },
      { org: "acme", type: "env", name: "D", vars: { PATH: { kind: "text", value: "/tmp" } } },
      { org: "acme", type: "env", name: "E", vars: { KEY: { kind: "secret", value: "sk-123" } } },
      { org: "acme", type: "ssh", name: "F", headers: {} },
    ] as const;
    for (const input of bad) {
      await expect(service.create(input, "connections.create", OWNER), input.name).rejects.toMatchObject({
        status: 400,
      });
    }
    expect(await yaml()).toBe(before);
  });
});
