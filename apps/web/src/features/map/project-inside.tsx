import type { PNode } from "./model";

/**
 * The place for the Project view's "Inside" part: what a project holds on its own (services, entry
 * points, flows, datastores, third-party calls), for projects with links and for those with none. It
 * renders nothing until its design is approved; `project-world.tsx` and the detail panel already
 * call it with the picked project, so it slots in without touching either.
 */
export function ProjectInside(_props: { node: PNode }) {
  return null;
}
