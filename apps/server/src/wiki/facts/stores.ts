import type { WikiFactBasis } from "@majhi/shared";
import { kebab, type ScanContext, storeSlug } from "./context.ts";
import { roleOfStore, type Store } from "./known.ts";
import type { Cite } from "./sink.ts";

/**
 * A datastore the repo uses: a `store` fact, and the `role` fact that says "this repo has a database / cache / queue
 * here". The store belongs to the unit that runs it when the repo deploys exactly one of that engine (or when
 * `unit` says which one). `where` is the folder or unit the role is shown at when no unit runs it.
 */
export function addStore(
  ctx: ScanContext,
  input: { store: Store; unit?: string | undefined; basis: WikiFactBasis; cite: Cite; where: string },
): void {
  const { store, basis, cite } = input;
  const unit = input.unit ?? ctx.unitFor(store);
  const where = unit ?? input.where;
  ctx.sink.add({
    kind: "store",
    name: store.label,
    role: store.kind,
    engine: store.label,
    ...(unit === undefined ? {} : { unit }),
    basis,
    slug: storeSlug(store, unit),
    cites: [cite],
  });
  ctx.sink.add({
    kind: "role",
    role: roleOfStore(store),
    where,
    tech: store.label,
    basis,
    slug: `${roleOfStore(store)}-${kebab(store.label)}-${kebab(where)}`,
    cites: [cite],
  });
}
