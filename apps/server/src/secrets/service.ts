import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  deriveSecretName,
  detectSecrets,
  kindOfSecret,
  replaceSecrets,
  type SecretMatch,
} from "@majhi/shared";
import type { ConfigService } from "../config/service.ts";
import { errorCode, UserError } from "../errors.ts";
import { SECRETS_NOT_SET_UP, type SecretStore } from "./store.ts";

const ref = (name: string) => `secret:${name}`;

/** Saving, listing and removing secrets, and pulling secrets out of text the owner typed. */
export class SecretService {
  constructor(
    private readonly store: SecretStore,
    private readonly config: ConfigService,
  ) {}

  async list(): Promise<{ name: string; ref: string }[]> {
    return (await this.store.names()).map((name) => ({ name, ref: ref(name) }));
  }

  async save(input: {
    name?: string | undefined;
    value: string;
    label?: string | undefined;
  }): Promise<{ name: string; ref: string }> {
    if (!(await this.store.available())) throw new UserError(SECRETS_NOT_SET_UP, 409);
    const taken = new Set(await this.store.names());
    if (input.name !== undefined && taken.has(input.name)) {
      throw new UserError(
        `A secret named ${input.name} already exists. Pick another name or remove it first.`,
        409,
      );
    }
    const name =
      input.name ?? deriveSecretName({ label: input.label, kind: kindOfSecret(input.value), taken });
    await this.store.set(name, input.value);
    return { name, ref: ref(name) };
  }

  async remove(name: string): Promise<void> {
    if (!(await this.store.has(name).catch(() => false))) {
      throw new UserError(`There is no secret named ${name}.`, 404);
    }
    const users = await this.referencedBy(name);
    if (users.length > 0) {
      throw new UserError(`${ref(name)} is used by ${users.join(", ")}. Remove that first.`, 409);
    }
    await this.store.delete(name);
  }

  /** Files of the config folder that name `secret:<name>`. */
  async referencedBy(name: string): Promise<string[]> {
    const pattern = new RegExp(`secret:${name}(?![a-z0-9-])`);
    const files = [this.config.file];
    const dir = join(this.config.paths.majhiHome, "agents");
    try {
      for (const entry of await readdir(dir)) if (entry.endsWith(".md")) files.push(join(dir, entry));
    } catch (err) {
      if (errorCode(err) !== "ENOENT") throw err;
    }
    const users: string[] = [];
    for (const file of files) {
      const text = await readFile(file, "utf8").catch(() => "");
      if (pattern.test(text))
        users.push(file.endsWith("majhi.yaml") ? "majhi.yaml" : `agents/${file.split("/").at(-1)}`);
    }
    return users;
  }

  /**
   * Saves every secret found in `text` and swaps each for its reference. The same value pasted
   * again reuses its name. Throws, saving nothing more, when secrets are not set up: the text must
   * not go on with a secret in it.
   */
  async capture(text: string): Promise<{ text: string; saved: string[] }> {
    const matches = detectSecrets(text);
    if (matches.length === 0) return { text, saved: [] };
    if (!(await this.store.available())) {
      throw new UserError(
        `This message holds a secret, and secrets are not set up yet. ${SECRETS_NOT_SET_UP}`,
        409,
      );
    }
    const taken = new Set(await this.store.names());
    const names = new Map<string, string>();
    const nameFor = async (m: SecretMatch): Promise<string> => {
      const known = names.get(m.value) ?? (await this.store.findName(m.value));
      if (known !== undefined) {
        names.set(m.value, known);
        return known;
      }
      const name = deriveSecretName({ kind: m.kind, taken });
      taken.add(name);
      await this.store.set(name, m.value);
      names.set(m.value, name);
      return name;
    };
    for (const m of matches) await nameFor(m);
    return {
      text: replaceSecrets(text, matches, (m) => ref(names.get(m.value) ?? "secret")),
      saved: [...new Set(names.values())].map(ref),
    };
  }
}
