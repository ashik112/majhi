import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { KEY_EXPORT_FILE_NAME, KeyFingerprintSchema } from "@majhi/shared";
import { z } from "zod";
import { errorCode } from "../errors.ts";
import type { SecretStore } from "./store.ts";

const RECORD_FILE = "secrets-key-backup.json";

/** Which key was last exported, and when. It holds no secret. */
const ExportRecordSchema = z.object({
  fingerprint: KeyFingerprintSchema,
  exportedAt: z.string(),
});
export type KeyExportRecord = z.infer<typeof ExportRecordSchema>;

/**
 * The passphrase-protected export of the secrets key (the Keychain or keyring copy is the host helper's).
 * majhi cannot see where the owner keeps the file, so it remembers which key it last exported:
 * a new key needs a new export.
 */
export class KeyExports {
  private readonly file: string;

  constructor(
    majhiHome: string,
    private readonly secrets: SecretStore,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.file = join(majhiHome, RECORD_FILE);
  }

  /** The last export. Undefined when there was none, or the file is unreadable. */
  async last(): Promise<KeyExportRecord | undefined> {
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (err) {
      if (errorCode(err) === "ENOENT") return undefined;
      throw err;
    }
    try {
      return ExportRecordSchema.parse(JSON.parse(text));
    } catch {
      return undefined;
    }
  }

  /** The armored age file for the owner to download. The passphrase is used once and dropped. */
  async export(passphrase: string, scryptLogN?: number): Promise<{ fileName: string; content: string }> {
    const content = await this.secrets.exportKey(passphrase, scryptLogN);
    const fingerprint = await this.secrets.fingerprint();
    if (fingerprint !== undefined) {
      await this.write({ fingerprint, exportedAt: this.now().toISOString() });
    }
    return { fileName: KEY_EXPORT_FILE_NAME, content };
  }

  private async write(record: KeyExportRecord): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    try {
      await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
      await rename(temp, this.file);
    } finally {
      await rm(temp, { force: true });
    }
  }
}
