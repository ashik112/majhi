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
});
