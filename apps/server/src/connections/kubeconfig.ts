import { isMap, isSeq, parseDocument, stringify } from "yaml";

/** A kubeconfig that cannot be cut down: not YAML, or no such context, cluster or user. */
export class KubeconfigError extends Error {}

/** Keys that point at files on the machine the kubeconfig came from. A run cannot see those. */
const FILE_KEYS = ["certificate-authority", "client-certificate", "client-key", "tokenFile"];

type Named = { name: string; [key: string]: unknown };

function named(list: unknown, what: string): Named[] {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new KubeconfigError(`The kubeconfig's ${what} is not a list.`);
  return list.filter((item): item is Named => typeof item === "object" && item !== null && "name" in item);
}

function body(item: Named | undefined, key: string): Record<string, unknown> {
  const value = item?.[key];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

interface Picked {
  cluster: Named;
  context: Named;
  user: Named | undefined;
}

/** The context, its cluster and its user, with `namespace` set on the context when given. */
function pick(text: string, context: string, namespace: string | undefined): Picked {
  const doc = parseDocument(text);
  if (doc.errors.length > 0 || !isMap(doc.contents)) {
    throw new KubeconfigError("The kubeconfig is not a YAML map.");
  }
  if (!isSeq(doc.get("contexts", true))) throw new KubeconfigError("The kubeconfig has no contexts.");
  const raw = doc.toJS() as Record<string, unknown>;
  const contexts = named(raw.contexts, "contexts");
  const chosen = contexts.find((c) => c.name === context);
  if (chosen === undefined) {
    const names = contexts.map((c) => c.name).join(", ");
    throw new KubeconfigError(`The kubeconfig has no context ${context}. It has: ${names || "none"}.`);
  }
  const ctx = body(chosen, "context");
  const clusterName = typeof ctx.cluster === "string" ? ctx.cluster : undefined;
  if (clusterName === undefined) throw new KubeconfigError(`Context ${context} names no cluster.`);
  const cluster = named(raw.clusters, "clusters").find((c) => c.name === clusterName);
  if (cluster === undefined) throw new KubeconfigError(`The kubeconfig has no cluster ${clusterName}.`);
  const userName = typeof ctx.user === "string" && ctx.user !== "" ? ctx.user : undefined;
  const user =
    userName === undefined ? undefined : named(raw.users, "users").find((u) => u.name === userName);
  if (userName !== undefined && user === undefined) {
    throw new KubeconfigError(`The kubeconfig has no user ${userName}.`);
  }
  for (const [what, section] of [
    ["cluster", body(cluster, "cluster")],
    ["user", body(user, "user")],
  ] as const) {
    const key = FILE_KEYS.find((k) => typeof section[k] === "string");
    if (key !== undefined) {
      throw new KubeconfigError(
        `The ${what} reads ${key} from a file. Upload a kubeconfig with the data embedded: kubectl config view --raw --flatten.`,
      );
    }
  }
  return {
    cluster,
    context: { ...chosen, context: { ...ctx, ...(namespace ? { namespace } : {}) } },
    user,
  };
}

function render(picked: readonly Picked[], current: string): string {
  const cut: Record<string, unknown> = {
    apiVersion: "v1",
    kind: "Config",
    clusters: picked.map((p) => p.cluster),
    contexts: picked.map((p) => p.context),
    users: picked.flatMap((p) => (p.user === undefined ? [] : [p.user])),
    "current-context": current,
  };
  // No folding: long base64 values stay on one line.
  return stringify(cut, { lineWidth: 0 });
}

/**
 * A kubeconfig that holds only `context`, its cluster and its user, with that context current and
 * `namespace` as its namespace when given. This is the copy a Test gets. Throws a KubeconfigError
 * that says what is missing, or which file a value points at, since a run only sees embedded data
 * (`kubectl config view --raw --flatten` embeds it).
 */
export function cutKubeconfig(text: string, context: string, namespace?: string): string {
  return render([pick(text, context, namespace)], context);
}

/**
 * One kubeconfig for a run that holds several kubectl connections: each one's context, cluster and
 * user, all named after the connection, so two connections can never clash and an agent picks one
 * with `--context <connection id>`. The first is current. A KubeconfigError names the connection.
 */
export function mergeKubeconfigs(
  parts: readonly { id: string; text: string; context: string; namespace?: string | undefined }[],
): string {
  const picked = parts.map((part) => {
    let one: Picked;
    try {
      one = pick(part.text, part.context, part.namespace);
    } catch (err) {
      if (err instanceof KubeconfigError) throw new KubeconfigError(`${part.id}: ${err.message}`);
      throw err;
    }
    const ctx = body(one.context, "context");
    return {
      cluster: { ...one.cluster, name: part.id },
      context: {
        name: part.id,
        context: { ...ctx, cluster: part.id, ...(one.user === undefined ? {} : { user: part.id }) },
      },
      user: one.user === undefined ? undefined : { ...one.user, name: part.id },
    };
  });
  return render(picked, parts[0]?.id ?? "");
}

/** Keys of a kubeconfig user that hold a credential. */
const CREDENTIAL_KEYS = ["token", "client-key-data", "password"];
const PROVIDER_KEYS = ["access-token", "id-token", "refresh-token", "client-secret"];

/** The credentials in a kubeconfig's users, so they can be kept out of the room. */
export function kubeconfigSecrets(text: string): string[] {
  const doc = parseDocument(text);
  if (doc.errors.length > 0 || !isMap(doc.contents)) return [];
  const raw = doc.toJS() as Record<string, unknown>;
  const out: string[] = [];
  for (const user of Array.isArray(raw.users) ? raw.users : []) {
    const section = body(user as Named, "user");
    for (const key of CREDENTIAL_KEYS) if (typeof section[key] === "string") out.push(section[key]);
    const config = body(body(section as Named, "auth-provider") as Named, "config");
    for (const key of PROVIDER_KEYS) if (typeof config[key] === "string") out.push(config[key]);
  }
  return out.filter((v) => v.length >= 8);
}
