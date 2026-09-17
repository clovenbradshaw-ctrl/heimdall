import { defineConfig } from "vite";

export default defineConfig({
  // Relative base so the built site works on GitHub Pages at any subpath.
  base: "./",
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