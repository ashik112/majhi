import { describe, expect, it } from "vitest";
import { codeLanguageOf, viewerKindOfPath } from "./media.ts";

describe("viewerKindOfPath", () => {
  it("picks the viewer by extension", () => {
    expect(viewerKindOfPath("MOVES.md")).toBe("markdown");
    expect(viewerKindOfPath("docs/Plan.MARKDOWN")).toBe("markdown");
    expect(viewerKindOfPath("media/chart.png")).toBe("image");
    expect(viewerKindOfPath("a/report.pdf")).toBe("pdf");
    expect(viewerKindOfPath("media/clip.mp4")).toBe("video");
    expect(viewerKindOfPath("media/song.mp3")).toBe("audio");
    for (const p of ["src/a.ts", "run.sh", "notes.txt", ".env.example", "Makefile", "data.bin"]) {
      expect(viewerKindOfPath(p), p).toBe("text");
    }
  });

  it("keeps pages and svg out of the app: they are sandboxed", () => {
    expect(viewerKindOfPath("media/report.html")).toBe("page");
    expect(viewerKindOfPath("drawing.svg")).toBe("page");
  });
});

describe("codeLanguageOf", () => {
  it("names the highlight.js language", () => {
    expect(codeLanguageOf("src/a.tsx")).toBe("typescript");
    expect(codeLanguageOf("config.toml")).toBe("ini");
    expect(codeLanguageOf("Dockerfile")).toBe("dockerfile");
    expect(codeLanguageOf("notes.txt")).toBeUndefined();
    expect(codeLanguageOf(".env.example")).toBeUndefined();
  });
});
