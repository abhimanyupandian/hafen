// Builds the app (app/) into app/dist: the browser build, which `npm run serve` (server/serve.js)
// serves, and the desktop app's window (desktop/main.js loads it). `npm run dev` serves it from source.
// The engine is the hafen package (hafen/engine/…): the workspace's packages/hafen, linked as
// node_modules/hafen, which Vite follows to its real path (in the project, so fs.allow takes it) and
// bundles as source, for the page, the engine's worker and the plugin worker alike.

import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const app = resolve(import.meta.dirname, "app");

export default defineConfig({
  root: app,
  base: "./",
  publicDir: resolve(app, "public"),
  plugins: [react()],
  // The design system's stylesheet (as hafen has it, unchanged) names the logo as ../icons/…, from
  // where hafen keeps its stylesheets: here the logo is the public folder's (/icons/…), which the
  // build then writes relative to the page, as the desktop app's file:// page needs
  resolve: { alias: [{ find: /^\.\.\/icons\//, replacement: "/icons/" }] },
  worker: { format: "es" },
  server: { port: 8790, fs: { allow: [import.meta.dirname] } },
  build: {
    outDir: resolve(app, "dist"),
    emptyOutDir: true,
    target: "es2022",
    // One page, one bundle (about 640 kB: React and the app's views), loaded from disk by the desktop
    // app. The engine's validators (Ajv, json-p3) stay out of it: tests/app/page-bundle.test.js
    chunkSizeWarningLimit: 800,
    rollupOptions: { input: { index: resolve(app, "index.html") } },
  },
});
