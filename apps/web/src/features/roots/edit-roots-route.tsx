import type { WorkspacesUpdateResult } from "@majhi/shared";
import { Navigate, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { CenteredPage } from "@/components/centered-page";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { ServerError } from "@/features/home/server-error";
import { useConfig } from "@/lib/queries";
import { draftFromConfig } from "./model";
import { RestartCard } from "./restart-card";
import { RootsForm } from "./roots-form";

/** `/settings/roots`: the onboarding roots form, filled with the current roots. */
export function EditRootsRoute() {
  const config = useConfig();
  const navigate = useNavigate();
  const toast = useToast();
  const [restart, setRestart] = useState<WorkspacesUpdateResult | null>(null);
  const state = config.data;
  const goHome = () => void navigate({ to: "/" });

  if (restart) {
    return (
      <CenteredPage>
        <RestartCard
          result={restart}
          home={restart.state.home}
          continueLabel="Show repos now"
          onContinue={goHome}
        />
      </CenteredPage>
    );
  }

  if (!state) {
    if (config.isError) {
      return (
        <ServerError
          error={config.error}
          onRetry={() => void config.refetch()}
          retrying={config.isFetching}
        />
      );
    }
    return <FormSkeleton />;
  }

  // First run and broken configs have their own screens at `/`.
  if (state.status !== "loaded") return <Navigate to="/" />;

  return (
    <CenteredPage>
      <RootsForm
        mode="edit"
        home={state.home}
        file={state.file}
        initial={draftFromConfig(state.config, state.home)}
        onSaved={(result) => {
          if (result.unmounted.length > 0) {
            setRestart(result);
            return;
          }
          toast("Roots saved");
          goHome();
        }}
        onCancel={goHome}
      />
    </CenteredPage>
  );
}

function FormSkeleton() {
  return (
    <main aria-busy="true" className="flex flex-1 justify-center px-6 pt-[10vh]">
      <span className="sr-only">Loading workspace roots</span>
      <div className="flex w-full max-w-[600px] flex-col gap-6">
        <div className="flex flex-col gap-2.5">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-3.5 w-96 max-w-full" />
        </div>
        <div className="flex flex-col gap-2 rounded-xl border border-line-strong bg-panel p-4">
          <Skeleton className="h-3 w-12" />
          <Skeleton className="h-10 w-full rounded-md" />
          <Skeleton className="h-10 w-full rounded-md" />
        </div>
      </div>
    </main>
  );
}
