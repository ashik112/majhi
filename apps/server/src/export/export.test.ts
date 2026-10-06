import { execFileSync } from "node:child_process";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { localSpawner } from "@majhi/acp";
import { Hono } from "hono";
import { extractText, getDocumentProxy } from "unpdf";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { taskFileRoutes } from "../http/taskFiles.ts";
import { tempDir } from "../testing/fixtures.ts";
import { runnerPdfPrinter } from "./pdf.ts";

/** A 1x1 PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const PLAN = `# Northwind launch plan

| Region | Owner |
| --- | --- |
| North | Acme |

![chart](../media/chart.png)

[docs](https://example.com/docs) and [run](javascript:alert(1))
`;

const hasChromium = (() => {
  try {
    execFileSync("chromium", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** The text of one entry of a zip, read from its central directory. Enough for a .docx. */
function zipEntry(zip: Buffer, name: string): string | undefined {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let at = zip.readUInt32LE(end + 16);
  for (let i = 0; i < zip.readUInt16LE(end + 10); i += 1) {
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const skip = nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    if (zip.toString("utf8", at + 46, at + 46 + nameLength) === name) {
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + size);
      return (method === 8 ? inflateRawSync(data) : data).toString("utf8");
    }
    at += 46 + skip;
  }
  return undefined;
}

describe("downloading a viewer file", () => {
  let dir: string;
  let folder: string;
  let cleanup: () => Promise<void>;
  let app: Hono;
  const download = (path: string, format: string) =>
    app.request(`/api/tasks/ACM-1/files/${path}?download=${format}`);

  beforeEach(async () => {
    ({ dir, cleanup } = await tempDir());
    folder = join(dir, "ACM-1");
    await mkdir(join(folder, "docs"), { recursive: true });
    await mkdir(join(folder, "media"));
    await writeFile(join(folder, "docs", "plan.md"), PLAN);
    await writeFile(join(folder, "media", "chart.png"), PNG);
    app = new Hono().route(
      "/api/tasks",
      taskFileRoutes({
        folderOf: (id) => (id === "ACM-1" ? folder : undefined),
        // The runner's print script, run next to the test with this machine's Chromium.
        pdf: runnerPdfPrinter({
          spawner: (req) => localSpawner({ ...req, isolated: false, cwd: tmpdir() }),
          base: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        }),
      }),
    );
  });
  afterEach(() => cleanup());

  it("md: the file as it is, named as it is", async () => {
    const res = await download("docs/plan.md", "raw");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="plan.md"; filename*=UTF-8''plan.md`,
    );
    expect(await res.text()).toBe(PLAN);
  });

  it("html: one page with the heading, the table and the image inside, and only safe links", async () => {
    const res = await download("docs/plan.md", "html");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("content-disposition")).toContain('filename="plan.html"');
    const html = await res.text();
    expect(html).toContain("<h1>Northwind launch plan</h1>");
    expect(html).toMatch(/<table>[\s\S]*<td>North<\/td>[\s\S]*<td>Acme<\/td>/);
    expect(html).toContain(`<img src="data:image/png;base64,${PNG.toString("base64")}" alt="chart">`);
    expect(html).toContain('<a href="https://example.com/docs">docs</a>');
    expect(html).not.toContain("javascript:");
    expect(html).not.toMatch(/<script/i);
  });

  it.skipIf(!hasChromium)(
    "pdf: a PDF that holds the heading and the table",
    async () => {
      const res = await download("docs/plan.md", "pdf");
      expect(res.status, await res.clone().text()).toBe(200);
      expect(res.headers.get("content-disposition")).toContain('filename="plan.pdf"');
      const pdf = new Uint8Array(await res.arrayBuffer());
      const { text } = await extractText(await getDocumentProxy(pdf), { mergePages: true });
      expect(text).toContain("Northwind launch plan");
      expect(text).toMatch(/Region\s+Owner\s+North\s+Acme/);
    },
    60_000,
  );

  it("docx: a Word file with the heading as a heading and the table as a table", async () => {
    const res = await download("docs/plan.md", "docx");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain('filename="plan.docx"');
    const xml = zipEntry(Buffer.from(await res.arrayBuffer()), "word/document.xml") ?? "";
    expect(xml).toMatch(/<w:pStyle w:val="Heading1"\/>[\s\S]*?Northwind launch plan/);
    expect(xml).toMatch(/<w:tbl>[\s\S]*North[\s\S]*Acme[\s\S]*<\/w:tbl>/);
    expect(xml).toContain("<w:drawing>");
  });

  it("reads only what the viewer may: no file or image outside the folder or behind a dot name", async () => {
    await writeFile(join(dir, "secret.png"), Buffer.concat([PNG, Buffer.from("OUTSIDE")]));
    await writeFile(join(dir, "outside.md"), "# Outside\n");
    await mkdir(join(folder, ".private"));
    await writeFile(join(folder, ".private", "notes.md"), "# Hidden\n");
    await writeFile(join(folder, ".private", "chart.png"), PNG);
    await symlink(join(dir, "outside.md"), join(folder, "linked.md"));
    await symlink(join(dir, "secret.png"), join(folder, "media", "linked.png"));
    for (const path of ["linked.md", ".private/notes.md", "..%2Foutside.md", "docs/..%2F..%2Foutside.md"]) {
      for (const format of ["raw", "html", "docx"]) {
        expect((await download(path, format)).status, `${path} ${format}`).not.toBe(200);
      }
    }
    expect((await download("media/chart.png", "html")).status).toBe(400);
    expect((await download("docs/plan.md", "exe")).status).toBe(400);

    // A document may name images anywhere; only those the viewer would serve are inlined.
    await writeFile(
      join(folder, "docs", "leaky.md"),
      `# Leaky\n\n![a](../../secret.png) ![b](../media/linked.png) ![c](../.private/chart.png) ![d](${join(dir, "secret.png")})\n`,
    );
    const html = await (await download("docs/leaky.md", "html")).text();
    expect(html).toContain("<h1>Leaky</h1>");
    expect(html).not.toContain("data:image");
  });
});
