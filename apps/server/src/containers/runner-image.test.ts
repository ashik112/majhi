import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dockerfile = readFileSync(join(import.meta.dirname, "../../../../Dockerfile"), "utf8");
const stage = (name: string): string => {
  const parts = dockerfile.split(/^FROM /m).filter((p) => p.includes(` AS ${name}\n`));
  return parts[0] ?? "";
};

describe("the runner image has doctl for script fetches and watches", () => {
  it("downloads a pinned release and checks its SHA-256 for each CPU", () => {
    const build = stage("doctl");
    expect(build).toMatch(/DOCTL_VERSION=\d+\.\d+\.\d+;/);
    expect(build).toMatch(/amd64\) DOCTL_SHA=[0-9a-f]{64} ;;/);
    expect(build).toMatch(/arm64\) DOCTL_SHA=[0-9a-f]{64} ;;/);
    expect(build).toContain('echo "${DOCTL_SHA}  doctl.tgz" | sha256sum -c -');
  });

  it("puts doctl on the runner's PATH, not in the server's runtime image", () => {
    const copy = "COPY --from=doctl /out/doctl /usr/local/bin/doctl";
    expect(stage("runner")).toContain(copy);
    expect(stage("runtime")).not.toContain(copy);
  });
});
