import { basename } from "node:path";
import { git } from "../git/git.ts";

/**
 * Whether a project looks like infra the owner would want protected: its id, an alias or its
 * folder names gitops, infra, terraform, helm, k8s, deploy or ops; or most of its tracked files are
 * Kubernetes, Helm, Argo CD or Terraform files. Only a hint for the UI, which offers to protect it.
 */
export async function looksLikeInfra(id: string, aliases: readonly string[], path: string): Promise<boolean> {
  if ([id, ...aliases, basename(path)].some(infraName)) return true;
  return infraFiles(path).catch(() => false);
}

const NAMES = ["gitops", "infra", "terraform", "helm", "k8s", "deploy", "kube", "argocd"];

/** True when a word of the name is infra-like: "acme-gitops", "deploy-scripts", "ops", "devops". */
export function infraName(name: string): boolean {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((word) => word === "ops" || word.endsWith("ops") || NAMES.some((n) => word.startsWith(n)));
}

/** More than half of the tracked files are infra files, and at least one marks the kind. */
async function infraFiles(path: string): Promise<boolean> {
  const files = (await git(path, ["ls-files", "-z"], { timeoutMs: 5_000 }))
    .split("\0")
    .filter((f) => f !== "");
  if (files.length === 0) return false;
  const marker = files.some((f) => MARKER.test(f));
  const infra = files.filter((f) => INFRA_FILE.test(f)).length;
  return marker && infra * 2 > files.length;
}

/** A file that says what the repo is: a Helm chart, a kustomization, Terraform, Argo CD. */
const MARKER = /(^|\/)(Chart\.yaml|kustomization\.ya?ml|[^/]+\.tf|argocd[^/]*\/|Application\.ya?ml)/i;
/** Config an infra repo is mostly made of. */
const INFRA_FILE = /\.(ya?ml|tf|tfvars|hcl|tpl|json)$|(^|\/)(Chart\.lock|\.helmignore)$/i;
