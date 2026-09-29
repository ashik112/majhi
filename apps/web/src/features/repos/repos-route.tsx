import { Navigate } from "@tanstack/react-router";
import { ServerError } from "@/features/home/server-error";
import { useConfig } from "@/lib/queries";
import { ReposScreen } from "./repos-screen";
import { ReposSkeleton } from "./repos-skeleton";

/** `/repos`: every repo under the workspace roots, where projects are registered. */
export function ReposRoute() {
  const config = useConfig();
  const state = config.data;
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
    return <ReposSkeleton />;
  }
  // First run and a broken config are handled on the home screen.
  if (state.status !== "loaded") return <Navigate to="/" />;
  return <ReposScreen home={state.home} />;
}
