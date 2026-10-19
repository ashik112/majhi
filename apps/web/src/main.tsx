import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./styles.css";
import "./console.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { LazyMotion, MotionConfig } from "motion/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ToastProvider } from "@/components/ui/toast";
import { ApiRequestError } from "@/lib/api";
import { startLook } from "@/lib/look";
import { router } from "./router";

startLook();

const loadMotionFeatures = () => import("./motion-features").then((m) => m.default);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Server events invalidate what changes, so a page switch shows the cache at once and refetches only when stale.
      staleTime: 10_000,
      // Retry only when the server did not answer; a 4xx or a contract mismatch will not fix itself.
      retry: (failures, error) => error instanceof ApiRequestError && error.unreachable && failures < 2,
    },
  },
});

const container = document.getElementById("root");
if (!container) throw new Error("index.html is missing #root");

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <LazyMotion features={loadMotionFeatures} strict>
        <MotionConfig reducedMotion="user">
          <ToastProvider>
            <RouterProvider router={router} />
          </ToastProvider>
        </MotionConfig>
      </LazyMotion>
    </QueryClientProvider>
  </StrictMode>,
);
