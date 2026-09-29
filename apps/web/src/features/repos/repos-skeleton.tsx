import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/cn";
import { ROW_GRID } from "./repo-row";

const NAME_WIDTHS = ["w-28", "w-36", "w-24", "w-40", "w-32", "w-28", "w-20"];
const PATH_WIDTHS = ["w-40", "w-56", "w-32", "w-64", "w-44", "w-36", "w-28"];

/** Stands in for the repos screen while the config or the first scan loads. */
export function ReposSkeleton() {
  return (
    <main aria-busy="true" aria-label="Loading repos" className="flex min-h-0 flex-1 flex-col">
      <span className="sr-only">Loading repos</span>
      <div className="flex h-[60px] shrink-0 items-center gap-4 border-b border-line px-5">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-3 w-52" />
        <div className="ml-auto flex items-center gap-2">
          <Skeleton className="h-[34px] w-72 rounded-md" />
          <Skeleton className="h-[34px] w-24 rounded-md" />
          <Skeleton className="h-[34px] w-24 rounded-md" />
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-hidden">
          {[
            { id: "first", rows: 7 },
            { id: "second", rows: 4 },
          ].map(({ id, rows }, group) => (
            <div key={id}>
              <div className="flex h-9 items-center gap-2.5 border-b border-line px-4">
                <Skeleton className="size-3.5" />
                <Skeleton className="h-3 w-28" />
              </div>
              {Array.from({ length: rows }, (_, i) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
                  key={i}
                  className={cn(ROW_GRID, "h-9 px-4")}
                >
                  <span />
                  <Skeleton className={cn("h-3", NAME_WIDTHS[(i + group) % NAME_WIDTHS.length])} />
                  <Skeleton
                    className={cn("hidden h-3 md:block", PATH_WIDTHS[(i + group) % PATH_WIDTHS.length])}
                  />
                  <Skeleton className="hidden h-3 w-16 md:block" />
                  <Skeleton className="h-3 w-20" />
                  <span className="hidden md:block" />
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="hidden w-[22rem] shrink-0 flex-col gap-5 border-l border-line bg-rail px-5 py-4 xl:flex">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-56" />
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-16 w-full rounded-md" />
        </div>
      </div>
    </main>
  );
}
