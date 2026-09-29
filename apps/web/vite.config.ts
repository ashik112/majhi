import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const server = "http://127.0.0.1:7070";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": decodeURIComponent(new URL("./src", import.meta.url).pathname) },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      // ws: the event feed and the login terminals are WebSockets under /api.
      "/api": { target: server, ws: true },
      "/health": server,
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // One bundle served from localhost by majhi itself; splitting it would not make it load faster.
    chunkSizeWarningLimit: 800,
  },
});
