import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { cutKubeconfig, KubeconfigError, mergeKubeconfigs } from "./kubeconfig.ts";

const PROD_TOKEN = "prod-viewer-token-0123456789";
const STAGING_TOKEN = "staging-admin-token-9876543210";

const KUBECONFIG = `apiVersion: v1
kind: Config
current-context: staging
clusters:
  - name: prod-eu
    cluster: { server: "https://prod.acme.example:6443", certificate-authority-data: "${"A".repeat(200)}" }
  - name: staging
    cluster: { server: "https://staging.acme.example:6443" }
contexts:
  - name: prod
    context: { cluster: prod-eu, user: viewer, namespace: default }
  - name: staging
    context: { cluster: staging, user: admin }
  - name: bare
    context: { cluster: staging }
users:
  - name: viewer
    user: { token: ${PROD_TOKEN} }
  - name: admin
    user: { token: ${STAGING_TOKEN} }
`;

describe("cutKubeconfig", () => {
  it("keeps only the context, its cluster and its user, current and in the namespace", () => {
    const text = cutKubeconfig(KUBECONFIG, "prod", "api");
    expect(text).not.toContain(STAGING_TOKEN);
    expect(text).not.toContain("staging.acme.example");
    const cut = parse(text);
    expect(cut["current-context"]).toBe("prod");
    expect(cut.contexts).toEqual([
      { name: "prod", context: { cluster: "prod-eu", user: "viewer", namespace: "api" } },
    ]);
    expect(cut.clusters.map((c: { name: string }) => c.name)).toEqual(["prod-eu"]);
    expect(cut.clusters[0].cluster["certificate-authority-data"]).toBe("A".repeat(200));
    expect(cut.users).toEqual([{ name: "viewer", user: { token: PROD_TOKEN } }]);
  });

  it("refuses values read from files, which a run cannot see", () => {
    const withFile = KUBECONFIG.replace(`token: ${PROD_TOKEN}`, "client-key: /Users/owner/.kube/key.pem");
    expect(() => cutKubeconfig(withFile, "prod")).toThrow("reads client-key from a file");
  });
});

describe("mergeKubeconfigs", () => {
  it("names each connection's context, cluster and user after it, the first one current", () => {
    const merged = parse(
      mergeKubeconfigs([
        { id: "acme-prod", text: KUBECONFIG, context: "prod", namespace: "api" },
        { id: "acme-staging", text: KUBECONFIG, context: "staging" },
      ]),
    );
    expect(merged["current-context"]).toBe("acme-prod");
    expect(merged.contexts).toEqual([
      { name: "acme-prod", context: { cluster: "acme-prod", user: "acme-prod", namespace: "api" } },
      { name: "acme-staging", context: { cluster: "acme-staging", user: "acme-staging" } },
    ]);
    expect(merged.clusters.map((c: { name: string }) => c.name)).toEqual(["acme-prod", "acme-staging"]);
    expect(merged.users).toEqual([
      { name: "acme-prod", user: { token: PROD_TOKEN } },
      { name: "acme-staging", user: { token: STAGING_TOKEN } },
    ]);
  });

});
