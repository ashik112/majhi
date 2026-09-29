import { Skeleton } from "@/components/ui/skeleton";

/** Stands in for the task screen while the config loads. */
export function HomeLoading() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading" className="flex min-h-0 flex-1">
      <span className="sr-only">Loading</span>
      <div className="flex w-[362px] shrink-0 flex-col gap-3 border-r border-line bg-rail p-3.5">
        <Skeleton className="h-[76px] w-full rounded-lg" />
        <Skeleton className="h-[76px] w-full rounded-lg" />
        <Skeleton className="h-[76px] w-full rounded-lg" />
      </div>
      <div className="flex flex-1 flex-col gap-3 p-6">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-6 w-2/3" />
      </div>
    </div>
  );
}
