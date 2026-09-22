import { defineConfig } from "vite";

export default defineConfig({
  // Relative base so the built site works on GitHub Pages at any subpath.
  base: "./",
  // One id per build: a phone on an older page is told to reload itself.
  define: { __BUILD__: JSON.stringify(new Date().toISOString()) },
  build: {
    target: "esnext",
    sourcemap: true,
    chunkSizeWarningLimit: 8000,
    rollupOptions: {
      output: {
        manualChunks: {
          matrix: ["matrix-js-sdk"],
          webllm: ["@mlc-ai/web-llm"],
        },
      },
    },
  },
});