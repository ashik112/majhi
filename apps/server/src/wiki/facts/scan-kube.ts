import { z } from "zod";
import type { Resolver } from "../system/resolver.ts";
import type { MapBuilder } from "./builder.ts";
import type { Loaded } from "./facts.ts";
import { lineContaining } from "./located.ts";
import { envExcerpt, linkFromValue } from "./scan-env.ts";

/**
 * Kubernetes manifests and Helm values, when simple: the environment of each container, and the `env`
 * of a values file. Helm templates are not YAML until rendered, so they are not read.
 */

const EnvItem = z.looseObject({ name: z.string(), value: z.string().optional().catch(undefined) });
const Container = z.looseObject({ env: z.array(EnvItem).optional().catch(undefined) });
const Pod = z.looseObject({ containers: z.array(Container).optional().catch(undefined) });
const Template = z.looseObject({ spec: Pod.optional().catch(undefined) });
const Workload = z.looseObject({
  kind: z.string(),
  spec: z
    .looseObject({
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

export function scanKube(loaded: Loaded, ctx: { resolver: Resolver; b: MapBuilder }): void {
  const self = loaded.facts.id;
  const link = (key: string, value: string, file: string, text: string, line: number | undefined) => {
    const at = line ?? lineContaining(text, key) ?? 1;
    linkFromValue({ ...ctx, self }, self, key, value, {
      project: self,
      file,
      line: at,
      excerpt: envExcerpt(key, value),
    });
  };
  for (const f of loaded.kube) {
    for (const doc of f.docs) {
      if (f.values) {
        const values = Values.safeParse(doc.data);
        if (!values.success) continue;
        const env = values.data.env;
        if (Array.isArray(env)) {
          env.forEach((item, i) => {
            if (item.value !== undefined) link(item.name, item.value, f.file, f.text, doc.lineOf(["env", i]));
          });
        } else if (env !== undefined) {
          for (const [key, value] of Object.entries(env)) {
            if (typeof value === "string") link(key, value, f.file, f.text, doc.lineOf(["env", key]));
          }
        }
        (values.data.extraEnv ?? []).forEach((item, i) => {
          if (item.value !== undefined)
            link(item.name, item.value, f.file, f.text, doc.lineOf(["extraEnv", i]));
        });
        continue;
      }
      const work = Workload.safeParse(doc.data);
      if (!work.success || !KINDS.has(work.data.kind)) continue;
      const spec = work.data.spec;
      const pod = spec?.template?.spec ?? spec?.jobTemplate?.spec?.template?.spec;
      (pod?.containers ?? []).forEach((container, ci) => {
        const base = doc.lineOf(["spec", "template", "spec", "containers", ci, "env"]) ?? 1;
        for (const item of container.env ?? []) {
          if (item.value !== undefined) {
            link(item.name, item.value, f.file, f.text, lineContaining(f.text, item.name, base));
          }
        }
      });
    }
  }
}
