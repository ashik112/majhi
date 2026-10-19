import { describe, expect, it } from "vitest";
import { Background } from "./background.ts";

describe("Background", () => {
  it("waits for running work on stop, and refuses work after it", async () => {
    const background = new Background();
    const log: string[] = [];
    let finish: () => void = () => undefined;
    background.run(
      () =>
        new Promise<void>((resolve) => {
          finish = () => {
            log.push("first ended");
            resolve();
          };
        }),
    );
    const stopped = background.stop().then(() => log.push("stopped"));
    background.run(async () => {
      log.push("late work ran");
    });
    await Promise.resolve();
    expect(log).toEqual([]);
    finish();
    await stopped;
    expect(log).toEqual(["first ended", "stopped"]);
  });
});
