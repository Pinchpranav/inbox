import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// Dev server on :5174 — a loopback origin the openclaw gateway will trust.
//
// The gateway's plugin HTTP route (/plugins/projects/api) does NOT emit CORS
// headers and 401s on the OPTIONS preflight (auth runs before CORS), so a
// browser can't reach it cross-origin directly. We proxy a same-origin `/gw`
// prefix to the gateway instead: the app fetches http://localhost:5174/gw/...
// and opens ws://localhost:5174/gw, and Vite forwards to localhost:18789
// (server-side, no CORS) while injecting a loopback Origin so the gateway's
// origin-check passes. Set the app's gateway URL to http://localhost:5174/gw.
const GATEWAY_TARGET = process.env.OPENCLAW_GATEWAY_TARGET ?? "http://localhost:18789";
const PROXY_ORIGIN = "http://localhost:5174";

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      "/gw": {
        target: GATEWAY_TARGET,
        changeOrigin: true,
        ws: true,
        rewrite: (path) => path.replace(/^\/gw/, ""),
        configure: (proxy) => {
          // Always send a trusted loopback Origin so the gateway accepts the
          // request regardless of whether the browser attached one.
          proxy.on("proxyReq", (proxyReq) => {
            proxyReq.setHeader("Origin", PROXY_ORIGIN);
          });
          proxy.on("proxyReqWs", (proxyReq) => {
            proxyReq.setHeader("Origin", PROXY_ORIGIN);
          });
        },
      },
    },
  },
});