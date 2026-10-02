import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const server = "http://127.0.0.1:7070";

/** Where the emoji picker reads its data: `EMOJIBASE_URL` in src/components/emoji-picker.tsx. */
const EMOJIBASE_PATH = "/emojibase";
const EMOJIBASE_FILES = ["en/data.json", "en/messages.json"];

/**
 * Serves the emoji picker's data from majhi itself, so the picker works offline and never calls a
 * CDN. The files come from the pinned `emojibase-data` package: a middleware in dev, assets in the build.
 */
function emojibase(): Plugin {
  const require = createRequire(import.meta.url);
  const read = (file: string) => readFileSync(require.resolve(`emojibase-data/${file}`));
  return {
    name: "majhi-emojibase",
    configureServer(dev) {
      dev.middlewares.use(EMOJIBASE_PATH, (req, res, next) => {
        const file = EMOJIBASE_FILES.find((f) => req.url === `/${f}`);
        if (file === undefined) return next();
        res.setHeader("Content-Type", "application/json");
        res.end(read(file));
      });
    },
    generateBundle() {
      for (const file of EMOJIBASE_FILES) {
        this.emitFile({ type: "asset", fileName: `${EMOJIBASE_PATH.slice(1)}/${file}`, source: read(file) });
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), emojibase()],
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
