import type { WikiClaim } from "@majhi/shared";
import { cn } from "@/lib/cn";
import { BasisMark, type OpenSource, Sources, Text } from "./parts";

/** One claim as a step: its number in a circle, its sentence, then the files behind it and whether it is proven. */
export function StepRow({
  claim,
  step,
  changed,
  onOpen,
}: {
  claim: WikiClaim;
  step: number;
  changed: ReadonlySet<string>;
  onOpen: OpenSource;
}) {
  return (
    <li className="grid min-w-0 grid-cols-[22px_minmax(0,1fr)] gap-x-3 gap-y-1 py-2.5" data-claim={claim.n}>
      <span
        aria-hidden="true"
        className={cn(
          "grid size-[22px] place-items-center rounded-full font-mono text-[11px] leading-none",
          claim.proven
            ? "bg-selected text-fg shadow-[inset_0_0_0_1px_var(--c-line-control)]"
            : "text-fg-muted shadow-[inset_0_0_0_1.5px_var(--c-amber)]",
        )}
      >
        {step}
      </span>
      <Text className="leading-[22px]">{claim.text}</Text>
      <div className="col-start-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <Sources claim={claim} changed={changed} onOpen={onOpen} />
        </div>
        <BasisMark proven={claim.proven} />
      </div>
    </li>
  );
}

/** One claim as a fact: its sentence, with the files behind it and whether it is proven under it. */
export function FactRow({
  claim,
  changed,
  onOpen,
}: {
  claim: WikiClaim;
  changed: ReadonlySet<string>;
  onOpen: OpenSource;
}) {
  return (
    <li
      className="flex min-w-0 flex-col gap-1.5 border-t border-line py-2.5 first:border-t-0 first:pt-0"
      data-claim={claim.n}
    >
      <Text className="leading-5">{claim.text}</Text>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <Sources claim={claim} changed={changed} onOpen={onOpen} />
        </div>
        <BasisMark proven={claim.proven} />
      </div>
    </li>
  );
}
