import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Same-origin API: the browser only talks to the web origin; Vite forwards /api (console API, cookie session)
 * and /v1 (gateway) to the API process. Override the target with API_PROXY_TARGET (default http://127.0.0.1:3001,
 * the API's default API_PORT). The API's WEB_ORIGIN must equal the origin you open in the browser.
 */
const target = process.env["API_PROXY_TARGET"] ?? "http://127.0.0.1:3001";
const proxy = { "/api": target, "/v1": target };

export default defineConfig({
  plugins: [react()],
  server: { proxy },
  preview: { proxy },
});
