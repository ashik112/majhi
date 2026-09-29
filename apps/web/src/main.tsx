import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./styles.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { domAnimation, LazyMotion, MotionConfig } from "motion/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ToastProvider } from "@/components/ui/toast";
import { ApiRequestError } from "@/lib/api";
import { router } from "./router";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
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
      <LazyMotion features={domAnimation} strict>
        <MotionConfig reducedMotion="user">
          <ToastProvider>
            <RouterProvider router={router} />
          </ToastProvider>
        </MotionConfig>
      </LazyMotion>
    </QueryClientProvider>
  </StrictMode>,
);
