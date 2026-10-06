// Builds the app (app/) into app/dist: the browser build, which `hafen serve` serves, and the
// desktop app's window (desktop/main.js loads it). `npm run dev` serves it from source.

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
    rollupOptions: { input: { index: resolve(app, "index.html"), gallery: resolve(app, "gallery.html") } },
  },
});
