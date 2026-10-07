import { describe, expect, it } from "vitest";
import { ContainerRefused } from "./args.ts";
import { dockerfileImages } from "./dockerfile-images.ts";

const none = new Map<string, string>();
const images = (text: string, args: Record<string, string> = {}) =>
  dockerfileImages(text, new Map(Object.entries(args)));

describe("the images a Dockerfile pulls", () => {
  it("finds every FROM, skipping scratch and the stages it built itself", () => {
    expect(
      images(
        "FROM node:22 AS build\nRUN npm ci\nFROM --platform=linux/amd64 nginx:1.27 AS web\nFROM build AS again\nFROM scratch\nFROM web\n",
      ),
    ).toEqual(["node:22", "nginx:1.27"]);
  });

  it("finds an image in COPY --from and RUN --mount from=, and ignores a stage name or an index", () => {
    expect(
      images(
        "FROM alpine:3 AS base\nCOPY --from=base /a /a\nCOPY --from=0 /a /b\nCOPY --from=busybox:1.36 /bin/busybox /bb\nADD --from=ghcr.io/acme/tool:1 /t /t\nRUN --mount=type=bind,from=redis:7,target=/r,source=/ true\n",
      ),
    ).toEqual(["alpine:3", "busybox:1.36", "ghcr.io/acme/tool:1", "redis:7"]);
  });

  it("finds the # syntax= frontend, and only where a directive can be", () => {
    expect(images("# syntax=docker/dockerfile:1.7\nFROM alpine:3\n")).toEqual([
      "docker/dockerfile:1.7",
      "alpine:3",
    ]);
    expect(images("FROM alpine:3\n# syntax=evil/frontend:1\n")).toEqual(["alpine:3"]);
  });

  it("joins continued lines and ignores comments", () => {
    expect(
      images("# FROM nope\nFROM \\\n  node:22 \\\n  AS build\n# COPY --from=other x y\nRUN true\n"),
    ).toEqual(["node:22"]);
  });

  it("resolves an ARG before FROM from its default or the build's --build-arg, and refuses what it cannot", () => {
    expect(images("ARG BASE=python:3.13-slim\nFROM ${BASE}\n")).toEqual(["python:3.13-slim"]);
    expect(images("ARG BASE=python:3.13-slim\nFROM $BASE\n", { BASE: "alpine:3" })).toEqual(["alpine:3"]);
    expect(images("ARG REG=ghcr.io/acme\nFROM ${REG}/web:1 AS w\n")).toEqual(["ghcr.io/acme/web:1"]);
    for (const text of [
      "FROM ${NOPE}\n",
      "ARG X\nFROM $X\n",
      "FROM ${NOPE}/img:1\n",
      "FROM\n",
      "FROM -x\n",
    ]) {
      expect(() => dockerfileImages(text, none), text).toThrow(ContainerRefused);
    }
  });
  it("reads lines the way BuildKit does, so no instruction hides from the check", () => {
    // `# escape=` moves the continuation character: a backslash no longer joins the next line.
    expect(images("# escape=`\nFROM alpine:3\nRUN echo \\\nFROM node:22\n")).toEqual(["alpine:3", "node:22"]);
    expect(images("# escape=`\nFROM alpine:3\nCOPY --from=node:22 \\\n  /a /b\n")).toEqual([
      "alpine:3",
      "node:22",
    ]);
    // A backtick joins the next line under it, and the default does not.
    expect(images("# escape=`\nFROM alpine:3\nRUN true `\nFROM node:22\n")).toEqual(["alpine:3"]);
    // Trailing blanks after the continuation character still continue the line.
    expect(images("FROM alpine:3\nRUN true \\  \nFROM node:22\n")).toEqual(["alpine:3"]);
    // An empty line or a comment inside a continued instruction does not end it.
    expect(images("FROM alpine:3\nRUN true \\\n\n# note\nFROM node:22\n")).toEqual(["alpine:3"]);
    // A byte order mark in front of the first line, and directive keys in any case.
    expect(images("\uFEFF# Escape = `\nFROM alpine:3\nRUN true \\\nFROM node:22\n")).toEqual([
      "alpine:3",
      "node:22",
    ]);
  });

  it("refuses a parser directive other than syntax, escape and check, a repeated one, and a bad escape", () => {
    for (const text of [
      "# foo=bar\nFROM alpine:3\n",
      "# escape=`\n# escape=\\\nFROM alpine:3\n",
      "# escape=x\nFROM alpine:3\n",
      "# syntax=docker/dockerfile:1\n# syntax=other/frontend:1\nFROM alpine:3\n",
    ]) {
      expect(() => images(text), text).toThrow(ContainerRefused);
    }
    expect(images("# check=skip=all\n# escape=`\nFROM alpine:3\n")).toEqual(["alpine:3"]);
    // Once a comment, an empty line or an instruction has gone by, a `key=value` comment is only a comment.
    expect(images("# note\n# foo=bar\nFROM alpine:3\n")).toEqual(["alpine:3"]);
  });
});
