import { z } from "zod";
import { kebab, type ScanContext } from "./context.ts";
import { roleOfImage } from "./known.ts";
import { dirOf, type KubeFile } from "./read.ts";
import { fromValue } from "./scan-env.ts";

/**
 * Kubernetes manifests and Helm values, when simple. Each workload (a Deployment, StatefulSet, DaemonSet, Job or
 * CronJob) is a unit; a CronJob is also a timer; the environment of each container is read like compose's. Helm
 * templates are not YAML until rendered, so they are not read.
 */

const EnvItem = z.looseObject({ name: z.string(), value: z.string().optional().catch(undefined) });
const Container = z.looseObject({
  image: z.string().optional().catch(undefined),
  env: z.array(EnvItem).optional().catch(undefined),
  ports: z
    .array(z.looseObject({ containerPort: z.number().int().optional().catch(undefined) }))
    .optional()
    .catch(undefined),
});
const Pod = z.looseObject({ containers: z.array(Container).optional().catch(undefined) });
const Template = z.looseObject({ spec: Pod.optional().catch(undefined) });
const Workload = z.looseObject({
  kind: z.string(),
  metadata: z
    .looseObject({ name: z.string().optional().catch(undefined) })
    .optional()
    .catch(undefined),
  spec: z
    .looseObject({
      schedule: z.string().optional().catch(undefined),
      template: Template.optional().catch(undefined),
      jobTemplate: z
        .looseObject({
          spec: z
            .looseObject({ template: Template.optional().catch(undefined) })
            .optional()
            .catch(undefined),
        })
        .optional()
        .catch(undefined),
    })
    .optional()
    .catch(undefined),
});

const KINDS: ReadonlySet<string> = new Set(["Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob"]);

const Values = z.looseObject({
  env: z
    .union([z.record(z.string(), z.unknown()), z.array(EnvItem)])
    .optional()
    .catch(undefined),
  extraEnv: z.array(EnvItem).optional().catch(undefined),
});

function scanFile(ctx: ScanContext, f: KubeFile): void {
  const where = dirOf(f.path) === "" ? "." : dirOf(f.path);
  for (const doc of f.docs) {
    if (f.values) {
      const values = Values.safeParse(doc.data);
      if (!values.success) continue;
      const setting = (key: string, value: string, path: (string | number)[]) => {
        const line = doc.lineOf(path) ?? 1;
        fromValue(ctx, { key, value, cite: { path: f.path, lines: [line, line] }, where });
      };
      const env = values.data.env;
      if (Array.isArray(env)) {
        env.forEach((item, i) => {
          if (item.value !== undefined) setting(item.name, item.value, ["env", i]);
        });
      } else if (env !== undefined) {
        for (const [key, value] of Object.entries(env)) {
          if (typeof value === "string") setting(key, value, ["env", key]);
        }
      }
      (values.data.extraEnv ?? []).forEach((item, i) => {
        if (item.value !== undefined) setting(item.name, item.value, ["extraEnv", i]);
      });
      continue;
    }
    const work = Workload.safeParse(doc.data);
    const name = work.success ? work.data.metadata?.name : undefined;
    if (!work.success || !KINDS.has(work.data.kind) || name === undefined) continue;
    const spec = work.data.spec;
    const pod = spec?.template?.spec ?? spec?.jobTemplate?.spec?.template?.spec;
    const containers = pod?.containers ?? [];
    const image = containers[0]?.image;
    const line = doc.lineOf(["metadata", "name"]) ?? doc.lineOf(["kind"]) ?? 1;
    ctx.sink.add({
      kind: "unit",
      name,
      role: (image === undefined ? undefined : roleOfImage(image)) ?? "unknown",
      runsOn: "Kubernetes",
      ...(image === undefined ? {} : { image }),
      ports: [
        ...new Set(
          containers.flatMap((c) => (c.ports ?? []).map((p) => p.containerPort ?? 0).filter((p) => p > 0)),
        ),
      ],
      dependsOn: [],
      basis: "declared",
      slug: name,
      cites: [{ path: f.path, lines: [line, line] }],
    });
    if (work.data.kind === "CronJob" && spec?.schedule !== undefined) {
      const at = doc.lineOf(["spec", "schedule"]) ?? line;
      ctx.sink.add({
        kind: "entry",
        entry: { type: "timer", schedule: spec.schedule, handler: name },
        basis: "declared",
        slug: `timer-${kebab(name)}`,
        cites: [{ path: f.path, lines: [at, at] }],
      });
    }
    containers.forEach((container, ci) => {
      (container.env ?? []).forEach((item, ei) => {
        if (item.value === undefined) return;
        const at = doc.lineOf(["spec", "template", "spec", "containers", ci, "env", ei]) ?? line;
        fromValue(ctx, {
          key: item.name,
          value: item.value,
          cite: { path: f.path, lines: [at, at] },
          where: name,
          unit: name,
        });
      });
    });
  }
}

export function scanKube(ctx: ScanContext): void {
  for (const f of ctx.scan.kube) scanFile(ctx, f);
}
