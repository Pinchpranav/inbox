import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// Dev server on :5174. The Hono backend (server/index.ts) runs on :8787 and
// serves both HTTP (/api/*) and WS (/api/chat/:key). We proxy a same-origin
// `/api` prefix to it so the browser talks to the backend without CORS, and
// forward WS upgrades (ws: true) for the chat stream.
const BACKEND_TARGET = process.env.INBOX_BACKEND_TARGET ?? "http://localhost:8787";

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      "/api": {
        target: BACKEND_TARGET,
        changeOrigin: true,
        ws: true,
      },
    },
  },
});