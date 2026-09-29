import { describe, expect, it } from "vitest";
import {
  inputMessage,
  type LoginState,
  nextLoginState,
  parseTerminalMessage,
  resizeMessage,
} from "./terminal-model";

const goodHealth = {
  ok: true,
  checkedAt: "t",
  durationMs: 5,
  steps: [{ name: "auth" as const, ok: true, detail: "a@b.c" }],
};
const badHealth = {
  ...goodHealth,
  ok: false,
  steps: [{ name: "auth" as const, ok: false, detail: "not signed in" }],
};

describe("parseTerminalMessage", () => {
  it("reads output and exit", () => {
    expect(parseTerminalMessage('{"type":"output","data":"hi"}')).toEqual({ kind: "output", data: "hi" });
    expect(parseTerminalMessage('{"type":"exit","code":0}')).toEqual({ kind: "exit", code: 0 });
    const withHealth = parseTerminalMessage(JSON.stringify({ type: "exit", code: 0, health: goodHealth }));
    expect(withHealth).toEqual({ kind: "exit", code: 0, health: goodHealth });
  });
  it("ignores anything else", () => {
    expect(parseTerminalMessage("{")).toEqual({ kind: "ignored" });
    expect(parseTerminalMessage('{"type":"exit","code":"x"}')).toEqual({ kind: "ignored" });
    expect(parseTerminalMessage(new ArrayBuffer(1))).toEqual({ kind: "ignored" });
  });
});

describe("client messages", () => {
  it("encodes input", () => {
    expect(JSON.parse(inputMessage("ls\r"))).toEqual({ type: "input", data: "ls\r" });
  });
  it("clamps resize to what the server accepts", () => {
    expect(JSON.parse(resizeMessage(2, 1000))).toEqual({ type: "resize", cols: 10, rows: 200 });
    expect(JSON.parse(resizeMessage(80.4, 24))).toEqual({ type: "resize", cols: 80, rows: 24 });
  });
});

describe("nextLoginState", () => {
  const running: LoginState = { phase: "running" };
  it("stays running on output", () => {
    expect(nextLoginState(running, { kind: "output", data: "x" })).toBe(running);
  });
  it("signs in when the command exits 0 and the check passes", () => {
    expect(nextLoginState(running, { kind: "exit", code: 0, health: goodHealth })).toEqual({
      phase: "signed-in",
      health: goodHealth,
    });
  });
  it("fails on a failing check, a non-zero exit or a missing check", () => {
    expect(nextLoginState(running, { kind: "exit", code: 0, health: badHealth })).toEqual({
      phase: "failed",
      code: 0,
      health: badHealth,
    });
    expect(nextLoginState(running, { kind: "exit", code: 1 })).toEqual({ phase: "failed", code: 1 });
    expect(nextLoginState(running, { kind: "exit", code: 0 })).toEqual({ phase: "failed", code: 0 });
  });
});
