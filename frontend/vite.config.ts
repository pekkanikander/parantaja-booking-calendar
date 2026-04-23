import { defineConfig } from "vite";

export default defineConfig({
  define: {
    __WORKER_URL__: JSON.stringify(process.env.VITE_WORKER_URL ?? "http://localhost:8787"),
  },
  build: {
    rollupOptions: {
      input: {
        main: "index.html",
        sw: "src/sw.ts",
      },
      output: {
        entryFileNames: (chunk) =>
          chunk.name === "sw" ? "sw.js" : "assets/[name]-[hash].js",
      },
    },
  },
});
